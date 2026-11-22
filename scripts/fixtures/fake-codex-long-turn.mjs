#!/usr/bin/env node
// Fake `codex exec --json` for long-turn timeout tests. It starts one simulated
// long command (for example a queue wait) and stays silent, or reports progress
// every FAKE_CODEX_PROGRESS_EVERY_MS, for FAKE_CODEX_TURN_MS before it completes.
// It records its pid and every SIGTERM it receives so tests can see how the
// bridge stopped it. It never runs a real command and never touches a GPU.

import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("fake-codex 1.0.0\n");
  process.exit(0);
}
if (args.includes("--help")) {
  process.stdout.write("--json --model --sandbox --cd --skip-git-repo-check --config\n");
  process.exit(0);
}

const turnMs = Number(process.env.FAKE_CODEX_TURN_MS || 1_000);
const progressEveryMs = Number(process.env.FAKE_CODEX_PROGRESS_EVERY_MS || 0);
const recordFile = process.env.FAKE_CODEX_RECORD_FILE || null;
const record = (entry) => {
  if (recordFile) appendFileSync(recordFile, `${JSON.stringify({ at: Date.now(), pid: process.pid, ...entry })}\n`);
};
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

record({ event: "started" });
process.on("SIGTERM", () => {
  record({ event: "SIGTERM" });
  if (process.env.FAKE_CODEX_IGNORE_SIGTERM === "1") return;
  // A cooperative Codex finishes its own shutdown, then exits with 143.
  process.exit(143);
});
// Hard cap so an orphaned fixture never outlives the test by much.
setTimeout(() => process.exit(3), Math.max(turnMs, 1_000) + 30_000).unref();

emit({ type: "thread.started", thread_id: "44444444-4444-4444-8444-444444444444" });
emit({ type: "turn.started" });
emit({ type: "item.started", item: { id: "command-1", type: "command_execution", command: "simulated-queue-wait", status: "in_progress" } });

let ticks = 0;
const ticker = progressEveryMs > 0
  ? setInterval(() => {
    ticks += 1;
    emit({ type: "item.completed", item: { id: `message-${ticks}`, type: "agent_message", text: `Still waiting in the simulated queue (${ticks}).` } });
  }, progressEveryMs)
  : null;

setTimeout(() => {
  if (ticker) clearInterval(ticker);
  emit({ type: "item.completed", item: { id: "command-1", type: "command_execution", command: "simulated-queue-wait", status: "completed", exit_code: 0 } });
  emit({ type: "item.completed", item: { id: "message-final", type: "agent_message", text: "FAKE_LONG_TURN_COMPLETE" } });
  emit({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
  record({ event: "completed" });
  process.exit(0);
}, turnMs);
