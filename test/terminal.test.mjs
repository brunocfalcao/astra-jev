import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { Terminal, terminalSafe, eventMessage } from "../src/terminal.mjs";
import { Status, statusLines } from "../src/status.mjs";

test("status never presents selection or publication as native capture", () => {
  const s = new Status();
  s.update({ type: "session_opened", mode: "adaptive-checkpoint" });
  s.update({
    type: "decision_selected",
    effort: "high",
    evaluatedModel: "jev-1.13.0",
    latencyMs: 250,
    leaseSteps: 1,
    policyVersion: "effort-v2",
    confidence: 0.4,
    leaseLimitedByUncertainty: true,
  });
  s.update({ type: "update_published" });
  assert.equal(s.snapshot().capturedEffort, null);
  assert.match(statusLines(s.snapshot()).join("\n"), /awaiting native capture/);
  assert.ok(
    statusLines(s.snapshot()).includes(
      "Jev policy: effort-v2 | Confidence: 0.4 | Lease: 1 generation(s) (shortened for uncertainty)",
    ),
  );
  s.update({ type: "effort_captured", effort: "high", generation: 2 });
  s.update({
    type: "decision_selected",
    effort: "low",
    evaluatedModel: "jev-1.13.0",
    latencyMs: 200,
  });
  assert.equal(s.snapshot().capturedEffort, "high");
  s.update({ type: "evaluation_failed", reason: "Jev timed out" });
  assert.equal(s.snapshot().jev, "degraded");
  assert.equal(s.snapshot().capturedEffort, "high");
  assert.match(
    eventMessage({
      type: "decision_selected",
      effort: "low",
      evaluatedModel: "jev-1.13.0",
      latencyMs: 200,
      leaseSteps: 1,
    }),
    /^Jev selected low/,
  );
});

test("external terminal controls stay visible text even across streamed chunks", () => {
  const chunks = [
    "normal\u001b",
    "]52;c;PRIVATE",
    "\u0007",
    "\u009b31m",
    "\u202eforged",
    "\nDone\t42",
  ];
  const visible = chunks.map(terminalSafe).join("");
  assert.equal(
    /[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e]/.test(visible),
    false,
  );
  assert.match(visible, /\\u001b/);
  assert.match(visible, /Done\t42/);
});

test("startup shows the thread once and leaves detailed evidence to /status", () => {
  const input = new PassThrough(), output = new PassThrough();
  let visible = "";
  output.on("data", (chunk) => (visible += chunk));
  const terminal = new Terminal({ input, output });
  try {
    terminal.header({ threadId: "thread-123", mode: "adaptive-checkpoint", status: { sandbox: "dangerFullAccess" } });
    assert.equal(visible.match(/Thread: thread-123/g)?.length, 1);
    assert.match(visible, /\/status evidence/);
    assert.doesNotMatch(visible, /Decision log:/);
  } finally {
    terminal.close();
  }
});

test("terminal commands stay local while busy and approvals are explicitly answered", async () => {
  const input = new PassThrough(),
    output = new PassThrough(),
    commands = [];
  let visible = "";
  output.on("data", (x) => (visible += x));
  const t = new Terminal({
    input,
    output,
    onCommand: async (command) => commands.push(command),
  });
  try {
    const prompt = t.prompt();
    input.write("/status\n");
    input.write("Investigate ALPHA\n");
    assert.equal(await prompt, "Investigate ALPHA");
    input.write("/interrupt\n");
    input.write("unexpected follow-up\n");
    const approval = t.ask("Approve? [y/N] ");
    input.write("no\n");
    assert.equal(await approval, "no");
    assert.deepEqual(commands, ["/status", "/interrupt"]);
    assert.match(visible, /Astra is working/);
    const pending = t.ask("Approve another? ");
    t.cancelQuestions();
    assert.equal(await pending, "");
    const next = t.prompt();
    t.close();
    assert.equal(await next, null);
  } finally {
    t.close();
  }
});
