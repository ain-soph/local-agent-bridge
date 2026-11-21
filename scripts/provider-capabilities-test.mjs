import assert from "node:assert/strict";
import { parseAntigravityModelLabels, parseAntigravityModels, parseProviderHelp } from "../src/provider-cli-capabilities.mjs";

const modernCodex = parseProviderHelp("codex", {
  version: "1", newHelp: "--json --model --sandbox --cd --skip-git-repo-check --config",
  resumeHelp: "--json --model --skip-git-repo-check --config",
});
assert.equal(modernCodex.newSession.sandbox, true);
assert.equal(modernCodex.resume.model, true);
const oldCodex = parseProviderHelp("codex", { newHelp: "--json --config", resumeHelp: "--json --config" });
assert.equal(oldCodex.newSession.skipGitRepoCheck, false);
assert.equal(oldCodex.resume.model, false);

const modernClaude = parseProviderHelp("claude", {
  mainHelp: "-p, --print --output-format --model --fallback-model --resume --strict-mcp-config --mcp-config --verbose --allowedTools --permission-mode --dangerously-skip-permissions --add-dir",
});
assert.equal(modernClaude.fallbackModel, true);
assert.equal(modernClaude.permissionMode, true);
assert.equal(modernClaude.addDir, true);
const oldClaude = parseProviderHelp("claude", { mainHelp: "-p, --print --output-format --model --resume --mcp-config" });
assert.equal(oldClaude.fallbackModel, false);
assert.equal(oldClaude.strictMcpConfig, false);

const modernAntigravity = parseProviderHelp("antigravity", {
  mainHelp: "--print --print-timeout --mode --model --effort --sandbox --dangerously-skip-permissions --conversation --log-file --add-dir",
});
assert.equal(modernAntigravity.conversation, true);
assert.equal(modernAntigravity.yolo, true);
assert.equal(modernAntigravity.logFile, true);
assert.equal(modernAntigravity.addDir, true);
assert.equal(modernAntigravity.effort, true);
const oldAntigravity = parseProviderHelp("antigravity", { mainHelp: "--print --print-timeout --mode --sandbox" });
assert.equal(oldAntigravity.model, false);
assert.equal(oldAntigravity.conversation, false);
assert.equal(oldAntigravity.addDir, false);
assert.equal(oldAntigravity.effort, false);

assert.deepEqual(parseAntigravityModels(`Available models:\n  * gemini-3.6-flash-high (default)\n  - gemini-3.6-flash-medium\nclaude-sonnet-4-6\n`), [
  "gemini-3.6-flash-high",
  "gemini-3.6-flash-medium",
  "claude-sonnet-4-6",
]);

const agy1514 = parseProviderHelp("antigravity", {
  mainHelp: "  --effort                        Reasoning effort for the current CLI session (low|medium|high|xhigh|max)\n  --settings                      Settings for this session only\n  --model  Model\n",
});
assert.deepEqual(agy1514.effortLevels, ["low", "medium", "high", "xhigh", "max"]);
assert.equal(agy1514.settings, true);
assert.equal(oldAntigravity.settings, false);
assert.equal(oldAntigravity.effortLevels, null);
assert.deepEqual(parseAntigravityModelLabels("Fetching available models...\ngemini-4-neon-xhigh\tGemini 4 Neon (XHigh)\ngemini-pro-orchestrator-neon\tOrchestrator (Neon)\ngpt-oss-120b-medium  GPT-OSS 120B (Medium)\n"), {
  "gemini-4-neon-xhigh": "Gemini 4 Neon (XHigh)",
  "gemini-pro-orchestrator-neon": "Orchestrator (Neon)",
  "gpt-oss-120b-medium": "GPT-OSS 120B (Medium)",
});

console.log("Provider capability matrix tests passed for modern and legacy Codex, Claude, and Antigravity CLIs.");
