#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfiguredFallbackModels, normalizeFallbackModels } from "./model-fallbacks.mjs";
import { resolveModelRoute } from "./model-policy.mjs";
import { loadConfiguredCodexModel } from "./provider-model-settings.mjs";
import { negotiateProviderCapabilities } from "./provider-cli-capabilities.mjs";

const WORKSPACE_ROOT = realpathSync(process.env.BRIDGE_WORKSPACE_ROOT || process.env.BRIDGE_ROOT || process.cwd());
const MAX_OUTPUT_CHARS = 200_000;
// How long a stopped Codex gets to finish after SIGTERM before SIGKILL.
const TERMINATE_GRACE_MS = positiveInteger(process.env.CODEX_BRIDGE_TERMINATE_GRACE_MS, 10_000);
// Liveness only: Codex prints nothing while one long command runs (for example a
// GPU queue wait). Callers must not rely on these to keep a call alive.
const HEARTBEAT_MS = 60_000;
// Codex processes owned by in-flight calls, so a cancelled call or a closed client
// stops them instead of leaving them running unobserved.
const activeCodexRuns = new Set();

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function logLine(message) {
  try {
    process.stderr.write(`[codex-bridge ${new Date().toISOString()}] ${message}\n`);
  } catch {}
}
function overloadRetryPrompt(originalPrompt) {
  return `A previous model attempt failed because that model was overloaded. Inspect the workspace before acting so you preserve any completed work, then complete this original request:\n\n${originalPrompt}`;
}

function findCodex() {
  const candidates = [
    process.env.CODEX_BRIDGE_CODEX_BIN,
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    join(homedir(), ".codex/plugins/.plugin-appserver/codex"),
  ];
  for (const directory of (process.env.PATH || "").split(delimiter)) {
    if (directory) candidates.push(join(directory, "codex"));
  }
  const found = candidates.find((candidate) => candidate && existsSync(candidate));
  if (!found) throw new Error("A working Codex binary was not found. Set CODEX_BRIDGE_CODEX_BIN.");
  return found;
}

const CODEX_BIN = findCodex();
const CODEX_CAPABILITIES = negotiateProviderCapabilities({ provider: "codex", binary: CODEX_BIN });

function projectDirectory(requested) {
  const candidate = resolve(WORKSPACE_ROOT, requested || ".");
  if (!existsSync(candidate) || !statSync(candidate).isDirectory()) {
    throw new Error(`Working directory does not exist: ${candidate}`);
  }
  const actual = realpathSync(candidate);
  const fromRoot = relative(WORKSPACE_ROOT, actual);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`Working directory must stay within ${WORKSPACE_ROOT}`);
  }
  return actual;
}

function clipped(value, maximum = MAX_OUTPUT_CHARS) {
  if (value.length <= maximum) return value;
  return `${value.slice(0, maximum)}\n\n[bridge output truncated]`;
}

function tomlValue(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function isModelOverload(message) {
  return /\bno requested model is currently available\b|(?:^|[^a-z0-9])overloaded(?:[^a-z0-9]|$)|\bmodel[_ -]?overload(?:ed)?\b|\bover[_ -]?capacity\b|\bmodel\b[^\n]{0,80}\bat capacity\b|\bno capacity\b[^\n]{0,80}\bmodel\b|\bmodel\b[^\n]{0,80}\bhigh demand\b|\bhigh demand\b[^\n]{0,80}\bmodel\b|\bexperiencing high demand\b/i.test(message);
}

function eventErrorText(event) {
  return [
    event.message,
    event.code,
    event.error?.message,
    event.error?.code,
    event.error?.type,
    typeof event.error === "string" ? event.error : null,
  ].filter((value) => typeof value === "string" && value.trim()).join(" — ") || "Codex reported an error.";
}

function eventSummary(event) {
  if (event.type === "thread.started") return "Codex session started.";
  if (event.type === "turn.started") return "Codex is analyzing the task.";
  if (event.type === "turn.completed") return "Codex finished the turn.";
  if (event.type === "turn.failed" || event.type === "error") return "Codex reported an error.";
  if (event.type !== "item.started" && event.type !== "item.completed") return null;
  const item = event.item || {};
  if (item.type === "agent_message" && typeof item.text === "string" && item.text.trim()) {
    return clipped(item.text.trim(), 500);
  }
  if (item.type === "command_execution") {
    return event.type === "item.started"
      ? `Codex is running workspace command: ${clipped(String(item.command || "unknown"), 300)}`
      : `Codex finished workspace command: ${clipped(String(item.command || "unknown"), 300)}${item.exit_code === null || item.exit_code === undefined ? "." : ` (exit ${item.exit_code}).`}`;
  }
  if (item.type === "file_change") return "Codex is applying workspace changes.";
  if (item.type === "mcp_tool_call") return "Codex is using an MCP tool.";
  if (item.type === "web_search") return "Codex is searching the web.";
  return null;
}

function turnLimitError(turnLimit, exit) {
  const stopped = exit
    ? ` The bridge stopped Codex with ${exit}.`
    : " The limit was reached before the next Codex attempt could start.";
  const error = new Error(`Codex delegation timed out after the ${turnLimit.budgetSeconds} s turn limit (turnTimeoutSeconds ${turnLimit.timeoutSeconds} s x ${turnLimit.attempts} model attempt${turnLimit.attempts === 1 ? "" : "s"}).${stopped} Commands Codex started end with it unless they were detached; partial work stays in the workspace. Use a larger turnTimeoutSeconds (up to 14400) for a longer turn.`);
  error.turnTimeout = true;
  return error;
}

function runCodexAttempt({ prompt, cwd, sandbox, approvalPolicy, config = {}, model, threadId, verificationCommands = [], onProgress, turnLimit = null, signal = null }) {
  if (process.env.CODEX_BRIDGE_ACTIVE === "1") {
    throw new Error("Nested Codex bridge invocation blocked to prevent an agent loop.");
  }
  const actualCwd = projectDirectory(cwd);
  const capabilities = threadId ? CODEX_CAPABILITIES.resume : CODEX_CAPABILITIES.newSession;
  if (!capabilities.json) throw new Error(`Installed Codex ${CODEX_CAPABILITIES.version} does not support required JSON event output on ${threadId ? "exec resume" : "exec"}.`);
  if (!capabilities.config) throw new Error(`Installed Codex ${CODEX_CAPABILITIES.version} does not support required --config overrides on ${threadId ? "exec resume" : "exec"}.`);
  if (model && !capabilities.model) throw new Error(`Installed Codex ${CODEX_CAPABILITIES.version} cannot select a model on ${threadId ? "exec resume" : "exec"}.`);
  const args = ["exec"];
  if (threadId) args.push("resume");
  args.push("--json");
  if (capabilities.skipGitRepoCheck) args.push("--skip-git-repo-check");
  if (!threadId) {
    if (capabilities.sandbox) args.push("--sandbox", sandbox);
    else args.push("--config", `sandbox_mode=${tomlValue(sandbox)}`);
    if (capabilities.cd) args.push("--cd", actualCwd);
  } else {
    args.push("--config", `sandbox_mode=${tomlValue(sandbox)}`);
  }
  args.push("--config", `approval_policy=${tomlValue(approvalPolicy)}`);
  for (const [key, value] of Object.entries(config || {})) {
    args.push("--config", `${key}=${tomlValue(value)}`);
  }
  if (model) args.push("--model", model);
  if (threadId) args.push(threadId);
  args.push(prompt);

  return new Promise((resolvePromise, rejectPromise) => {
    const wallStartedAt = Date.now();
    if (turnLimit && Date.now() >= turnLimit.deadlineAt) {
      rejectPromise(turnLimitError(turnLimit, null));
      return;
    }
    if (signal?.aborted) {
      rejectPromise(new Error("Codex call was cancelled by the MCP client before Codex started."));
      return;
    }
    const child = spawn(CODEX_BIN, args, {
      cwd: actualCwd,
      env: { ...process.env, CODEX_BRIDGE_ACTIVE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Set when the bridge itself stops Codex: at the turn limit, on cancellation,
    // or when the MCP client disconnects. Only the Codex process is signalled;
    // Codex ends the commands it started, while detached background jobs keep running.
    let stopping = null;
    let deadlineTimer = null;
    let killTimer = null;
    const stop = (reason) => {
      if (stopping || child.exitCode !== null || child.signalCode !== null) return;
      stopping = { reason, signals: ["SIGTERM"] };
      const what = reason === "turn_limit"
        ? `Codex reached the ${turnLimit.budgetSeconds} s turn limit`
        : reason === "cancelled"
          ? "The MCP client cancelled the Codex call"
          : "The MCP client disconnected";
      const message = `${what}; the bridge sent SIGTERM to Codex (pid ${child.pid}) and sends SIGKILL if it is still running after ${TERMINATE_GRACE_MS} ms.`;
      logLine(message);
      onProgress(message);
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        stopping.signals.push("SIGKILL");
        const killed = `Codex (pid ${child.pid}) was still running ${TERMINATE_GRACE_MS} ms after SIGTERM; the bridge sent SIGKILL.`;
        logLine(killed);
        onProgress(killed);
        child.kill("SIGKILL");
      }, TERMINATE_GRACE_MS);
      killTimer.unref?.();
    };
    const run = { stop };
    activeCodexRuns.add(run);
    if (turnLimit) {
      deadlineTimer = setTimeout(() => stop("turn_limit"), Math.max(0, turnLimit.deadlineAt - Date.now()));
      deadlineTimer.unref?.();
    }
    const onAbort = () => stop("cancelled");
    signal?.addEventListener("abort", onAbort, { once: true });
    const finishStop = () => {
      activeCodexRuns.delete(run);
      clearTimeout(deadlineTimer);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
    };
    let buffer = "";
    let stderr = "";
    let sessionId = threadId || null;
    let finalMessage = "";
    let eventError = null;
    let firstEventMs = null;
    let toolMs = 0;
    let toolCalls = 0;
    const activeTools = new Map();
    const verificationSet = new Set(verificationCommands.map((command) => String(command).trim()));
    const verificationResults = [];
    let reviewPublished = false;

    const consume = (line) => {
      if (!line.trim()) return;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      const observedAt = Date.now();
      if (firstEventMs === null) firstEventMs = observedAt - wallStartedAt;
      const item = event.item || {};
      const timedTool = ["command_execution", "mcp_tool_call", "web_search"].includes(item.type);
      if (timedTool && event.type === "item.started") {
        activeTools.set(item.id || `${item.type}:${toolCalls}`, {
          observedAt,
          startedAt: new Date(observedAt).toISOString(),
          command: item.type === "command_execution" ? String(item.command || "").trim() : null,
        });
        toolCalls += 1;
      } else if (timedTool && event.type === "item.completed") {
        const key = item.id || [...activeTools.keys()].find((candidate) => candidate.startsWith(`${item.type}:`));
        const started = activeTools.get(key);
        if (started !== undefined) {
          toolMs += Math.max(0, observedAt - started.observedAt);
          if (verificationSet.has(started.command) && Number.isInteger(item.exit_code)) {
            const serializedOutput = String(item.aggregated_output ?? item.output ?? "");
            verificationResults.push({
              command: started.command,
              exitCode: item.exit_code,
              startedAt: started.startedAt,
              completedAt: new Date(observedAt).toISOString(),
              outputDigest: createHash("sha256").update(serializedOutput).digest("hex"),
              outputSummary: clipped(serializedOutput, 1_000),
            });
          }
          activeTools.delete(key);
        }
        const server = String(item.server || item.server_name || "").replace(/^mcp__/, "");
        const tool = String(item.tool || item.name || item.tool_name || "").replace(/^mcp__github_review__/, "");
        if (item.type === "mcp_tool_call"
          && server === "github_review"
          && tool === "submit_pr_review"
          && !item.error
          && String(item.status || "").toLowerCase() === "completed") {
          reviewPublished = true;
        }
      }
      if (event.type === "thread.started" && event.thread_id) sessionId = event.thread_id;
      if (event.type === "item.completed" && event.item?.type === "agent_message" && event.item.text?.trim()) {
        finalMessage = event.item.text.trim();
      }
      if (event.type === "error" || event.type === "turn.failed") {
        eventError = eventErrorText(event);
      }
      const summary = eventSummary(event);
      if (summary) onProgress(summary);
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) consume(line);
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      finishStop();
      rejectPromise(error);
    });
    child.on("close", (code, exitSignal) => {
      finishStop();
      consume(buffer);
      if (stopping) {
        const exit = `${stopping.signals.join(", then ")}; it exited with ${code ?? exitSignal}`;
        if (stopping.reason === "turn_limit") {
          rejectPromise(turnLimitError(turnLimit, exit));
        } else {
          rejectPromise(new Error(`Codex call was stopped because ${stopping.reason === "cancelled" ? "the MCP client cancelled it" : "the MCP client disconnected"}; the bridge sent Codex ${exit}.`));
        }
        return;
      }
      if (code !== 0 || eventError) {
        const error = new Error(clipped(eventError || stderr.trim() || `Codex exited with ${code ?? exitSignal}.`));
        error.modelOverloaded = isModelOverload(error.message);
        rejectPromise(error);
        return;
      }
      const totalMs = Date.now() - wallStartedAt;
      resolvePromise({
        content: clipped(finalMessage || "Codex returned no text."),
        threadId: sessionId,
        isError: false,
        timing: {
          totalMs,
          firstResponseMs: firstEventMs,
          toolMs,
          toolCalls,
          inferenceMs: Math.max(0, totalMs - toolMs),
          inferenceEstimated: true,
        },
        verificationResults,
        reviewPublished,
      });
    });
  });
}

async function runCodex({
  prompt,
  cwd,
  sandbox,
  approvalPolicy,
  config = {},
  model,
  fallbackModels,
  threadId,
  verificationCommands = [],
  onProgress,
  timeoutSeconds,
  signal = null,
}) {
  let configured;
  if (fallbackModels === undefined) {
    try {
      configured = loadConfiguredFallbackModels("codex");
    } catch (error) {
      configured = [];
      onProgress(`Ignoring invalid machine model-fallback policy: ${error.message}`);
    }
  } else {
    configured = normalizeFallbackModels(fallbackModels, "fallbackModels");
  }
  const machineModelPolicy = resolveModelRoute({
    provider: "codex",
    model,
    configuredModel: loadConfiguredCodexModel(),
    fallbackModels: configured,
  });
  configured = machineModelPolicy.fallbackModels;
  if (machineModelPolicy.blockedModels.length) {
    onProgress(`Machine model policy skipped ${machineModelPolicy.blockedModels.join(", ")}; using ${machineModelPolicy.model || "the provider-configured model"}.`);
  }
  const candidates = [machineModelPolicy.model || null, ...configured]
    .filter((candidate, index, values) => values.indexOf(candidate) === index);
  // One wall-clock limit for the whole call: turnTimeoutSeconds per permitted model
  // attempt, the same bound the collaboration broker uses for its own deadline.
  const turnLimit = timeoutSeconds === undefined ? null : {
    timeoutSeconds,
    attempts: candidates.length,
    budgetSeconds: timeoutSeconds * candidates.length,
    deadlineAt: Date.now() + timeoutSeconds * 1000 * candidates.length,
  };
  const attemptedModels = [];
  const originalThreadId = threadId || null;
  let activeThreadId = originalThreadId;
  let attemptPrompt = prompt;

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const label = candidate || "configured default";
    attemptedModels.push(label);
    try {
      const result = await runCodexAttempt({
        prompt: attemptPrompt,
        cwd,
        sandbox,
        approvalPolicy,
        config,
        model: candidate,
        threadId: activeThreadId,
        verificationCommands,
        onProgress,
        turnLimit,
        signal,
      });
      return {
        ...result,
        requestedModel: model || null,
        model: candidate,
        fallbackUsed: machineModelPolicy.source === "fallback" || index > 0,
        attemptedModels,
        modelFallbacks: configured,
        fallbackManagedBy: configured.length ? "bridge" : null,
        modelPolicy: machineModelPolicy,
      };
    } catch (error) {
      const next = candidates[index + 1];
      if (!error.modelOverloaded) throw error;
      if (next === undefined) {
        const suffix = configured.length
          ? `Codex model fallback chain exhausted: ${attemptedModels.join(" -> ")}.`
          : "No Codex model fallback was configured.";
        throw new Error(`${error.message}\n${suffix}`);
      }
      const nextLabel = next || "configured default";
      onProgress(`Codex model ${label} is overloaded; retrying with ${nextLabel} (${index + 1}/${candidates.length - 1}).`);
      // A newly-created failed thread may not contain the original user turn. Start a
      // fresh attempt in that case. For codex-reply, retain only the caller's established
      // thread and repeat the prompt so the fallback cannot silently lose the new ask.
      activeThreadId = originalThreadId;
      attemptPrompt = overloadRetryPrompt(prompt);
    }
  }
  throw new Error("Codex model fallback chain was empty.");
}

const server = new McpServer(
  { name: "codex-live-progress-bridge", version: "0.2.0" },
  { instructions: "Use codex for a new delegated turn and codex-reply with the returned threadId for continuation. Structured Codex lifecycle events are forwarded as progress notifications." },
);

const configSchema = z.record(z.string(), z.unknown()).default({});
const newTurnInput = {
  prompt: z.string().min(1),
  cwd: z.string().default("."),
  sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).default("read-only"),
  "approval-policy": z.enum(["untrusted", "on-failure", "on-request", "never"]).default("never"),
  config: configSchema,
  model: z.string().min(1).optional(),
  fallbackModels: z.array(z.string().trim().min(1)).max(5).optional().describe(
    "Ordered models to try only when Codex reports that the current model is overloaded. Omit to use ~/.config/local-agent-bridge/model-fallbacks.json; pass [] to disable configured fallbacks.",
  ),
  verificationCommands: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
  timeoutSeconds: z.number().int().min(1).max(14400).optional().describe(
    "Wall-clock limit for this turn per permitted model attempt. At the limit the bridge stops Codex (SIGTERM, then SIGKILL after a grace period) and returns a timeout error. Omit for no bridge-side limit.",
  ),
};

async function runWithProgress(input, extra, threadId) {
  const token = extra?._meta?.progressToken;
  let progress = 0;
  const notify = (message) => {
    if (token === undefined) return;
    progress += 1;
    extra.sendNotification({
      method: "notifications/progress",
      params: { progressToken: token, progress, message },
    }).catch(() => {});
  };
  const startedAt = Date.now();
  const heartbeat = setInterval(() => {
    notify(`Codex is still working (${Math.round((Date.now() - startedAt) / 1000)}s heartbeat).`);
  }, HEARTBEAT_MS);
  heartbeat.unref?.();
  try {
    return await runCodex({
      prompt: input.prompt,
      cwd: input.cwd || ".",
      sandbox: input.sandbox || "read-only",
      approvalPolicy: input["approval-policy"] || "never",
      config: input.config,
      model: input.model,
      fallbackModels: input.fallbackModels,
      threadId,
      verificationCommands: input.verificationCommands || [],
      onProgress: notify,
      timeoutSeconds: input.timeoutSeconds,
      signal: extra?.signal || null,
    });
  } finally {
    clearInterval(heartbeat);
  }
}

function toolResponse(result) {
  return {
    content: [{ type: "text", text: result.content }],
    structuredContent: result,
    isError: result.isError,
  };
}

server.registerTool("codex", {
  title: "Codex",
  description: "Start a Codex turn with live lifecycle progress.",
  inputSchema: newTurnInput,
}, async (input, extra) => toolResponse(await runWithProgress(input, extra)));

server.registerTool("codex-reply", {
  title: "Continue Codex",
  description: "Continue a Codex turn by threadId with live lifecycle progress. Re-pass the intended sandbox and approval policy; omitted continuation permissions fail closed to read-only and never.",
  inputSchema: {
    threadId: z.string().min(1),
    ...newTurnInput,
  },
}, async ({ threadId, ...input }, extra) => toolResponse(await runWithProgress(input, extra, threadId)));

// Stop owned Codex processes when the MCP client goes away (stdin closes or the
// client's transport sends SIGTERM) instead of orphaning them, then exit.
let shuttingDown = false;
function shutdown(reason, exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (activeCodexRuns.size) logLine(`${reason}; stopping ${activeCodexRuns.size} running Codex process(es).`);
  for (const run of activeCodexRuns) run.stop("disconnected");
  const exitWhenIdle = setInterval(() => {
    if (!activeCodexRuns.size) process.exit(exitCode);
  }, 50);
  setTimeout(() => process.exit(exitCode), TERMINATE_GRACE_MS + 1_000).unref();
  exitWhenIdle.unref?.();
}
process.stdin.once("end", () => shutdown("MCP client closed stdin", 0));
process.once("SIGTERM", () => shutdown("Received SIGTERM", 143));

await server.connect(new StdioServerTransport());
