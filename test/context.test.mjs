import test from "node:test";
import assert from "node:assert/strict";
import { Context } from "../src/context.mjs";
import { Controller } from "../src/controller.mjs";

test("truncated tool previews retain bounded redacted middle diagnostics and turn provenance", () => {
  const context = new Context({ secrets: ["fixture-sensitive-key"] });
  context.reset("Install tools");
  const output =
    "Package metadata\n".repeat(300) +
    "Dependency conflict: stable tool requires framework <=7.\nCurrent framework is 8. Preserve existing lock-file edits.\napi_key=fixture-sensitive-key\n" +
    "More package metadata\n".repeat(300);
  context.addHook({
    tool_use_id: "nested",
    tool_name: "Bash",
    tool_input: {},
    tool_response: output,
  });
  const before = context.state();
  assert.equal(
    before.recentToolCalls[0].output.includes("Dependency conflict"),
    false,
  );
  assert.match(
    before.recentToolCalls[0].diagnosticExcerpt,
    /Dependency conflict/,
  );
  assert.match(
    before.recentToolCalls[0].diagnosticExcerpt,
    /Current framework is 8/,
  );
  assert.equal(JSON.stringify(before).includes("fixture-sensitive-key"), false);
  assert.equal(before.recentToolCalls[0].userPromptIndex, 1);
  assert.equal(context.stats().diagnosticToolCalls, 1);
  assert.equal(context.stats().omittedDiagnosticExcerpts, 0);
  context.nextTurn("Report results");
  assert.equal(context.state().userPromptIndex, 2);
  assert.equal(context.state().recentToolCalls[0].userPromptIndex, 1);
  context.add({
    type: "function_call_output",
    call_id: "raw",
    output: JSON.stringify({ output }),
  });
  assert.match(
    context.state().recentToolCalls.at(-1).diagnosticExcerpt,
    /Dependency conflict/,
  );
  assert.equal(context.state().recentToolCalls.at(-1).userPromptIndex, 2);
  context.addHook({
    tool_use_id: "many",
    tool_name: "Bash",
    tool_input: {},
    tool_response: "Warning: fixture detail\n".repeat(1000),
  });
  const last = context.state().recentToolCalls.at(-1);
  assert.ok(last.diagnosticExcerpt.length <= 1250);
  assert.ok(last.omittedDiagnosticExcerpts > 0);
  context.addHook({
    tool_use_id: "short",
    tool_name: "Bash",
    tool_input: {},
    tool_response: "No errors",
  });
  assert.equal(
    context.state().recentToolCalls.at(-1).diagnosticExcerpt,
    undefined,
  );
});

test("long conversations retain the original request and disclose omitted evidence", () => {
  const c = new Context({ secrets: ["fixture-private-value"] });
  c.reset("Preserve ALPHA; password=fixture-private-value");
  for (let n = 1; n <= 7; n++) c.nextTurn(`Follow-up ${n}`);
  for (let n = 0; n < 9; n++) {
    const event = {
      tool_use_id: String(n),
      tool_name: "read",
      tool_input: {},
      tool_response: "x".repeat(12000),
    };
    c.addHook(event);
    c.add({
      type: "function_call_output",
      call_id: String(n),
      output: event.tool_response,
    });
  }
  const state = c.state();
  assert.match(state.originalUserPrompt, /Preserve ALPHA/);
  assert.equal(state.latestUserPrompt, "Follow-up 7");
  assert.deepEqual(state.priorUserPrompts, [
    "Follow-up 4",
    "Follow-up 5",
    "Follow-up 6",
  ]);
  assert.equal(state.omittedOlderUserPrompts, 3); // Original retained separately.
  assert.equal(state.omittedOlderToolCalls, 3); // Hook/raw duplicates count once.
  assert.equal(state.recentToolCalls.length, 6);
  assert.equal(state.recentToolCalls[0].truncation.output, true);
  assert.equal(JSON.stringify(state).includes("fixture-private-value"), false);
  c.reset("A new thread");
  assert.equal(c.state().originalUserPrompt, "A new thread");
  assert.equal(c.state().omittedOlderToolCalls, 0);
});

test("resumed history keeps its earliest request without loading every old turn", () => {
  const c = new Context();
  c.hydrate(
    Array.from({ length: 10 }, (_, n) => ({
      items: [
        {
          type: "userMessage",
          content: [
            { type: "text", text: n ? `Follow-up ${n}` : "Preserve OMEGA" },
          ],
        },
      ],
    })),
  );
  c.nextTurn("Continue");
  assert.equal(c.state().originalUserPrompt, "Preserve OMEGA");
  assert.deepEqual(c.state().priorUserPrompts, [
    "Follow-up 7",
    "Follow-up 8",
    "Follow-up 9",
  ]);
  assert.equal(c.state().omittedOlderUserPrompts, 6);
});

test("Jev receives scoped public plans and exact native failure metadata", async () => {
  const states = [],
    logs = [];
  const c = new Controller({
    supportedEfforts: ["low"],
    context: new Context({ secrets: ["fixture-secret"] }),
    jev: {
      decide: async (state) => {
        states.push(state);
        return { effort: "low", leaseSteps: 2 };
      },
    },
    rpc: async () => ({ status: "applied" }),
    record: (x) => logs.push(x),
  });
  await c.begin({
    threadId: "t",
    prompt: "Preserve ALPHA",
    defaultEffort: "low",
  });
  c.attach("u");
  const emit = (method, extra) =>
    c.handle(method, { threadId: "t", turnId: "u", ...extra });
  await emit("rawResponseItem/completed", {
    item: { type: "configuration_update", reasoning: { effort: "low" } },
  });
  await c.handle("turn/plan/updated", {
    threadId: "foreign",
    turnId: "u",
    plan: [{ step: "FOREIGN", status: "pending" }],
  });
  await emit("turn/plan/updated", {
    explanation: "Check fixture-secret",
    plan: [{ step: "Verify atomic writes", status: "inProgress" }],
  });
  await emit("item/completed", {
    item: {
      id: "ok",
      type: "commandExecution",
      status: "completed",
      exitCode: 0,
    },
  });
  assert.equal(c.remaining, 2);
  const failure = {
    item: {
      id: "failed",
      type: "commandExecution",
      status: "completed",
      exitCode: 2,
    },
  };
  await emit("item/completed", failure);
  await emit("item/completed", failure);
  await emit("rawResponse/completed", { responseId: "r1" });
  await emit("rawResponseItem/completed", {
    item: { type: "function_call_output", call_id: "x", output: "result" },
  });
  assert.equal(states.length, 2);
  assert.deepEqual(states[1].currentPlan.steps, [
    { step: "Verify atomic writes", status: "inProgress" },
  ]);
  assert.equal(states[1].newToolFailures, 1);
  assert.deepEqual(states[1].recentToolFailures, [
    { type: "commandExecution", status: "completed", exitCode: 2 },
  ]);
  assert.equal(JSON.stringify(states).includes("fixture-secret"), false);
  assert.equal(JSON.stringify(states).includes("FOREIGN"), false);
  assert.equal(JSON.stringify(logs).includes("Verify atomic writes"), false);
  assert.ok(
    logs.some(
      (x) =>
        x.type === "evaluation_requested" && x.contextStats.toolFailures === 1,
    ),
  );
  await c.evaluate();
  assert.equal(states[2].newToolFailures, 0);
});
