// Regression test: a long provider turn (for example a Codex turn that waits in a
// GPU queue without printing anything) must be bounded by the collaboration's
// turnTimeoutSeconds, not by MCP request inactivity, and running past that limit
// must end in a definite, recoverable failure instead of `indeterminate`.
//
// Everything runs on a fake Codex binary with second-scale limits: no model, no
// network, no GPU, no gpu-lock. The real production path is exercised:
// collaboration-worker -> scripts/codex-mcp.sh -> src/codex-bridge.mjs -> fake codex.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createCollaboration, readCollaboration } from "../src/collaboration-store.mjs";
import { providerCallTimeoutMs, PROVIDER_DEADLINE_GRACE_MS } from "../src/agent-pool.mjs";
import { classifyProviderFailure } from "../src/provider-failover.mjs";

const root = resolve(import.meta.dirname, "..");
const temporary = await mkdtemp(join(tmpdir(), "provider-turn-timeout-test-"));
const stateDirectory = join(temporary, "state");
const workspace = join(temporary, "workspace");
await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
process.env.BRIDGE_COLLABORATION_DIR = stateDirectory;
await mkdir(workspace, { recursive: true });
await mkdir(join(temporary, "codex-source-home"), { recursive: true });
await writeFile(join(workspace, "README.md"), "# turn timeout fixture\n");
for (const args of [
  ["init", "-q"],
  ["config", "user.email", "bridge@example.test"],
  ["config", "user.name", "Bridge Test"],
  ["config", "commit.gpgsign", "false"],
  ["add", "README.md"],
  ["commit", "-qm", "fixture"],
]) {
  const result = spawnSync("git", args, { cwd: workspace, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Unable to prepare the workspace fixture: ${result.stderr || result.stdout}`);
}
const fakeCodex = join(temporary, "codex");
await writeFile(fakeCodex, `#!/bin/sh\nexec "${process.execPath}" "${resolve(root, "scripts/fixtures/fake-codex-long-turn.mjs")}" "$@"\n`);
await chmod(fakeCodex, 0o700);

const cleanProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => (
  !name.startsWith("BRIDGE_")
  && !name.startsWith("FAKE_")
  && !["CLAUDE_BRIDGE_ACTIVE", "CODEX_BRIDGE_ACTIVE", "ANTIGRAVITY_BRIDGE_ACTIVE", "CODEX_HOME"].includes(name)
)));
const baseEnv = {
  ...cleanProcessEnv,
  AGENT_BRIDGE_TEST_MODE: "1",
  AGENT_BRIDGE_ATTENTION_NOTIFICATIONS: "0",
  AGENT_BRIDGE_KEEP_MODELS_WARM: "0",
  AGENT_BRIDGE_MODEL_FALLBACKS_CONFIG: join(temporary, "no-model-fallbacks.json"),
  NODE_BIN: process.execPath,
  BRIDGE_RUNTIME_ROOT: root,
  BRIDGE_WORKSPACE_ROOT: temporary,
  BRIDGE_COLLABORATION_DIR: stateDirectory,
  BRIDGE_SOURCE_CODEX_HOME: join(temporary, "codex-source-home"),
  BRIDGE_CODEX_HOME: join(temporary, "codex-home"),
  CODEX_BRIDGE_CODEX_BIN: fakeCodex,
  // Scaled-down shutdown windows; production defaults are 60 s and 10 s.
  BRIDGE_PROVIDER_DEADLINE_GRACE_MS: "3000",
  CODEX_BRIDGE_TERMINATE_GRACE_MS: "500",
};

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function records(file) {
  try {
    return (await readFile(file, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function events(id) {
  return (await readFile(join(stateDirectory, `${id}.jsonl`), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
}

// Run one single-turn Codex collaboration through the real worker.
async function runWorker(name, { turnTimeoutSeconds, fakeEnv }) {
  const recordFile = join(temporary, `${name}.records.jsonl`);
  const task = `Turn timeout scenario: ${name}`;
  const collaboration = await createCollaboration(workspace, {
    task,
    taskBase: task,
    workspace,
    agents: ["codex"],
    startAgent: "codex",
    mode: "review",
    status: "queued",
    run: { maxTurns: 1 },
    budget: {},
    providerRecovery: { enabled: false, maxAttempts: 0, backoffSeconds: [] },
    providerRecoveryState: { attempts: 0, status: "idle" },
    turnTimeoutSeconds,
    runtime: {
      sessions: { codex: null },
      nextAgent: "codex",
      previousMessage: null,
      previousAgent: null,
      agreementStreak: 0,
      turnCount: 0,
      activeCall: null,
      availableAgents: ["codex"],
      unavailableAgents: {},
    },
  });
  const startedAt = Date.now();
  const child = spawn(process.execPath, [resolve(root, "scripts/collaboration-worker.mjs"), collaboration.id], {
    cwd: root,
    env: { ...baseEnv, ...fakeEnv, FAKE_CODEX_RECORD_FILE: recordFile },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 45_000);
  const code = await new Promise((resolvePromise) => child.on("close", resolvePromise));
  clearTimeout(watchdog);
  const elapsedMs = Date.now() - startedAt;
  const state = await readCollaboration(workspace, collaboration.id);
  return {
    name,
    code,
    output,
    elapsedMs,
    state,
    events: await events(collaboration.id),
    records: await records(recordFile),
  };
}

function describe(run) {
  return `${run.name}: status=${run.state.status} error=${run.state.error} elapsed=${run.elapsedMs}ms\n${run.output}`;
}

function assertDefiniteTurnTimeout(run) {
  assert.notEqual(run.state.status, "indeterminate", describe(run));
  assert.equal(run.state.status, "failed", describe(run));
  assert.ok(!run.events.some((event) => event.type === "agent_indeterminate"), describe(run));
  assert.match(run.state.error || "", /turn limit/i, describe(run));
  const unavailable = run.events.find((event) => event.type === "agent_unavailable" && event.agent === "codex");
  assert.ok(unavailable, describe(run));
  assert.match(unavailable.reason, /Codex delegation timed out after the 1 s turn limit/);
  // The stop is logged in the collaboration transcript before the turn fails.
  assert.ok(run.events.some((event) => event.type === "agent_progress" && /turn limit[^\n]*SIGTERM/i.test(event.summary || "")), describe(run));
  // No provider-owned process is left behind.
  const started = run.records.find((entry) => entry.event === "started");
  assert.ok(started, describe(run));
  assert.equal(processAlive(started.pid), false, `${run.name}: fake Codex pid ${started.pid} is still running`);
  assert.ok(run.records.some((entry) => entry.event === "SIGTERM"), `${run.name}: Codex did not receive SIGTERM first`);
  assert.ok(!run.records.some((entry) => entry.event === "completed"), describe(run));
}

const toolSchemas = async () => {
  const client = new Client({ name: "provider-turn-timeout-schema-test", version: "1" });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [resolve(root, "src/collaboration-bridge.mjs")],
    cwd: root,
    env: baseEnv,
  }));
  try {
    const { tools } = await client.listTools();
    return Object.fromEntries(tools.map((tool) => [tool.name, tool.inputSchema]));
  } finally {
    await client.close();
  }
};

// Direct MCP check: when the caller gives up on a Codex call, the bridge must stop
// the Codex process it owns instead of leaving it running unobserved.
async function abortedCall() {
  const recordFile = join(temporary, "aborted-call.records.jsonl");
  const client = new Client({ name: "provider-turn-timeout-abort-test", version: "1" });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [resolve(root, "src/codex-bridge.mjs")],
    cwd: root,
    env: { ...baseEnv, FAKE_CODEX_TURN_MS: "9000", FAKE_CODEX_RECORD_FILE: recordFile },
  }));
  try {
    await assert.rejects(client.callTool({
      name: "codex",
      arguments: { prompt: "wait", cwd: workspace, sandbox: "read-only", "approval-policy": "never", config: {} },
    }, undefined, { timeout: 700 }), /timed out/i);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !(await records(recordFile)).some((entry) => entry.event === "SIGTERM")) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
    const observed = await records(recordFile);
    assert.ok(observed.some((entry) => entry.event === "SIGTERM"), "a cancelled Codex call must stop its Codex process");
    const started = observed.find((entry) => entry.event === "started");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
    assert.equal(processAlive(started.pid), false);
  } finally {
    await client.close();
  }
}

try {
  const [schemas, withinLimit, silentPastLimit, chattyPastLimit, stubbornPastLimit] = await Promise.all([
    toolSchemas(),
    // 1. A silent turn that stays inside its limit completes, however quiet it is.
    runWorker("silent-within-limit", { turnTimeoutSeconds: 4, fakeEnv: { FAKE_CODEX_TURN_MS: "2500" } }),
    // 2. A silent turn past its limit (the gpu-lock queue case) fails definitively.
    runWorker("silent-past-limit", { turnTimeoutSeconds: 1, fakeEnv: { FAKE_CODEX_TURN_MS: "9000" } }),
    // 3. Progress does not stretch a turn past its limit or defer the decision.
    runWorker("progress-past-limit", { turnTimeoutSeconds: 1, fakeEnv: { FAKE_CODEX_TURN_MS: "9000", FAKE_CODEX_PROGRESS_EVERY_MS: "250" } }),
    // 4. A Codex that ignores SIGTERM is killed after the shutdown grace period.
    runWorker("sigterm-ignored", { turnTimeoutSeconds: 1, fakeEnv: { FAKE_CODEX_TURN_MS: "9000", FAKE_CODEX_IGNORE_SIGTERM: "1" } }),
  ]);

  if (process.env.TURN_TIMEOUT_TEST_DEBUG) for (const run of [withinLimit, silentPastLimit, chattyPastLimit, stubbornPastLimit]) console.error(describe(run));

  const failures = [];
  const check = async (name, fn) => {
    try {
      await fn();
      console.log(`ok - ${name}`);
    } catch (error) {
      failures.push(name);
      console.log(`not ok - ${name}\n  ${String(error.message).split("\n").slice(0, 3).join("\n  ")}`);
    }
  };

  await check("turnTimeoutSeconds accepts a 2-hour queue plus work (>= 14400 s)", () => {
    for (const tool of ["start_collaboration", "continue_collaboration"]) {
      const limit = schemas[tool]?.properties?.turnTimeoutSeconds;
      assert.ok(limit, `${tool} must expose turnTimeoutSeconds`);
      assert.ok(limit.maximum >= 14_400, `${tool}.turnTimeoutSeconds maximum is ${limit.maximum}`);
    }
  });

  await check("a silent turn inside its limit completes", () => {
    assert.equal(withinLimit.state.status, "turn_limit", describe(withinLimit));
    assert.equal(withinLimit.state.error, null, describe(withinLimit));
    const turn = withinLimit.events.find((event) => event.type === "turn" && event.agent === "codex");
    assert.match(turn?.message || "", /FAKE_LONG_TURN_COMPLETE/, describe(withinLimit));
    assert.ok(withinLimit.records.some((entry) => entry.event === "completed"), describe(withinLimit));
    assert.ok(!withinLimit.records.some((entry) => entry.event === "SIGTERM"), describe(withinLimit));
  });

  // Enforced at the configured limit plus the shutdown windows, not after an inactivity window.
  const enforcementBoundMs = 1_000 + Number(baseEnv.BRIDGE_PROVIDER_DEADLINE_GRACE_MS) + 3_000;
  await check("a silent turn past its limit fails definitively (not indeterminate), Codex stopped with SIGTERM", () => {
    assertDefiniteTurnTimeout(silentPastLimit);
    assert.ok(silentPastLimit.elapsedMs < enforcementBoundMs, `took ${silentPastLimit.elapsedMs} ms`);
  });
  await check("progress does not extend a turn past its limit; the failure is definite", () => {
    assertDefiniteTurnTimeout(chattyPastLimit);
    assert.ok(chattyPastLimit.events.filter((event) => event.type === "agent_progress").length >= 2, describe(chattyPastLimit));
    assert.ok(chattyPastLimit.elapsedMs < enforcementBoundMs, `took ${chattyPastLimit.elapsedMs} ms`);
  });
  await check("a Codex that ignores SIGTERM is killed after the grace period and the failure says so", () => {
    assertDefiniteTurnTimeout(stubbornPastLimit);
    assert.match(stubbornPastLimit.state.error, /SIGKILL/, describe(stubbornPastLimit));
    assert.ok(stubbornPastLimit.elapsedMs < enforcementBoundMs, `took ${stubbornPastLimit.elapsedMs} ms`);
  });
  await check("a cancelled Codex MCP call stops its Codex process", abortedCall);
  await check("the client deadline is the turn limit x attempts + grace, with no progress dependence", () => {
    assert.equal(providerCallTimeoutMs({ turnTimeoutSeconds: 7_200 }), 7_200_000 + PROVIDER_DEADLINE_GRACE_MS);
    assert.equal(providerCallTimeoutMs({ turnTimeoutSeconds: 14_400, fallbackSlots: 1, graceMs: 0 }), 28_800_000);
  });
  await check("a turn-limit failure is a definite transport failure, never quota or capacity", () => {
    for (const seconds of [401, 429, 503, 529, 3600]) {
      const reason = `codex MCP call failed: Codex delegation timed out after the ${seconds} s turn limit (turnTimeoutSeconds ${seconds} s x 1 model attempt).`;
      assert.equal(classifyProviderFailure(new Error(reason)), "transport", reason);
    }
  });

  console.log(JSON.stringify({
    withinLimit: { status: withinLimit.state.status, elapsedMs: withinLimit.elapsedMs },
    silentPastLimit: { status: silentPastLimit.state.status, elapsedMs: silentPastLimit.elapsedMs, error: String(silentPastLimit.state.error).split("\n")[0] },
    progressPastLimit: { status: chattyPastLimit.state.status, elapsedMs: chattyPastLimit.elapsedMs, error: String(chattyPastLimit.state.error).split("\n")[0] },
    sigtermIgnored: { status: stubbornPastLimit.state.status, elapsedMs: stubbornPastLimit.elapsedMs, error: String(stubbornPastLimit.state.error).split("\n")[0] },
  }, null, 2));
  if (failures.length) {
    console.log(`${failures.length} check(s) failed`);
    process.exitCode = 1;
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
