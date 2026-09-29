import test from "node:test";
import assert from "node:assert/strict";
import { Context } from "../src/context.mjs";
import { Controller } from "../src/controller.mjs";
import { Jev, decisionRequest } from "../src/jev.mjs";

for (const route of ["raw", "hook"])
  test(`Jev receives middle evidence that fits its request budget through ${route} results`, async () => {
    const requests = [],
      records = [];
    const context = new Context({ secrets: ["fixture-evidence-secret"] });
    context.model = "gpt-6.1-sol";
    const c = new Controller({
      supportedEfforts: ["low", "high"],
      context,
      gated: route === "hook",
      captureEvents: route === "raw",
      record: (event) => records.push(event),
      jev: new Jev({
        key: "fixture-provider-key",
        fetchImpl: async (_, options) => {
          requests.push(JSON.parse(options.body));
          return new Response(
            JSON.stringify({
              model: "jev-1.13.0",
              answers: {
                effort: { type: "choice", choice: "low" },
                lease: { type: "choice", choice: "1" },
              },
            }),
          );
        },
      }),
      rpc: async () => ({ status: "applied" }),
    });
    await c.begin({
      threadId: "evidence-thread",
      prompt: "Assess the review outcome",
      defaultEffort: "low",
    });
    c.attach("evidence-turn");
    const emit = (method, extra) =>
      c.handle(method, {
        threadId: "evidence-thread",
        turnId: "evidence-turn",
        ...extra,
      });
    if (route === "raw")
      await emit("rawResponseItem/completed", {
        item: { type: "configuration_update", reasoning: { effort: "low" } },
      });
    let generation = 0;
    const submit = async (id, output) => {
      if (route === "raw") {
        await emit("rawResponse/completed", {
          responseId: `response-${++generation}`,
        });
        await emit("rawResponseItem/completed", {
          item: { type: "function_call_output", call_id: id, output },
        });
      } else {
        await c.checkpoint({
          session_id: "evidence-thread",
          turn_id: "evidence-turn",
          tool_use_id: id,
          tool_name: "read",
          tool_input: {},
          tool_response: output,
        });
      }
    };
    await submit("healthy", "READ_READY");
    assert.equal(requests.at(-1).state.recentToolCalls[0].output, "READ_READY");
    const evidence =
      "Accepted 7 of 17 records. Approval types lost their definitions. Reviewers used different revisions.";
    const output =
      "Source inventory entry\n".repeat(200) + evidence +
      "\napi_key=fixture-evidence-secret\n" +
      "Source inventory entry\n".repeat(200);
    assert.ok(
      Buffer.byteLength(JSON.stringify(decisionRequest({
        ...requests.at(-1).state,
        recentToolCalls: [{ output }],
      }))) < 128 * 1024,
    );
    await submit("review", output);
    const sent = requests.at(-1);
    assert.ok(sent.state.recentToolCalls.at(-1).output.includes(evidence));
    assert.equal(sent.state.recentToolCalls.at(-1).truncation.output, false);
    assert.equal(sent.state.recentToolCalls[0].output, "READ_READY");
    assert.equal(JSON.stringify(sent).includes("fixture-evidence-secret"), false);
    assert.equal(context.stats().truncatedToolCalls, 0);
    assert.ok(Buffer.byteLength(JSON.stringify(sent)) < 128 * 1024);
    await submit("later", "x".repeat(45000) + "RECENT_MIDDLE" + "y".repeat(45000));
    const latest = requests.at(-1).state;
    assert.ok(latest.recentToolCalls.at(-1).output.includes("RECENT_MIDDLE"));
    assert.equal(latest.recentToolCalls[0].output, "READ_READY");
    const truncated = latest.recentToolCalls.filter((call) => call.truncation.output).length;
    assert.ok(truncated > 0);
    assert.equal(records.filter((event) => event.type === "evaluation_requested").at(-1)
      .contextStats.truncatedToolCalls, truncated);
    assert.ok(Buffer.byteLength(JSON.stringify(requests.at(-1))) < 128 * 1024);
    assert.equal(requests.length, 4);
  });

test("a shared evidence budget keeps recent middle facts and reports actual omissions", () => {
  const context = new Context();
  context.reset("Interpret the latest source result");
  for (let index = 0; index < 6; index++) {
    context.addHook({
      tool_use_id: `source-${index}`, tool_name: "read", tool_input: {},
      tool_response: `BEGIN-${index}\n` + "Archive passage\n".repeat(700) +
        `MIDDLE-${index}: distinct revision and approval evidence\n` +
        "Archive passage\n".repeat(700) + `END-${index}`,
    });
  }
  const state = context.state({ supportedEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"] });
  assert.ok(state.recentToolCalls.at(-1).output.includes("MIDDLE-5"));
  assert.equal(state.recentToolCalls.at(-1).truncation.output, false);
  assert.ok(state.recentToolCalls.some((call) => call.truncation.output));
  assert.equal(context.stats().truncatedToolCalls,
    state.recentToolCalls.filter((call) => call.truncation.output).length);
  assert.ok(Buffer.byteLength(JSON.stringify(decisionRequest(state))) < 128 * 1024);
  assert.deepEqual(context.state(), context.state());
  for (const [index, call] of state.recentToolCalls.entries()) {
    assert.ok(call.output.includes(`BEGIN-${index}`));
    assert.ok(call.output.includes(`END-${index}`));
  }
});

test("evidence allocation accounts for UTF-8 and JSON escaping without mutating retained results", () => {
  const context = new Context({ secrets: ["fixture-budget-secret"] });
  context.reset("Inspect source evidence");
  for (let index = 0; index < 6; index++)
    context.addHook({
      tool_use_id: `unicode-${index}`, tool_name: "read", tool_input: {},
      tool_response: "🙂\"\\\n".repeat(3000) +
        `\nFACT-${index}: distinct approval evidence\npassword=fixture-budget-secret\n` +
        "🙂\"\\\n".repeat(3000),
    });
  const retained = JSON.stringify(context.outputs);
  const state = context.state({ supportedEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"] });
  assert.ok(Buffer.byteLength(JSON.stringify(state)) <= 96 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(decisionRequest(state))) < 128 * 1024);
  assert.ok(state.recentToolCalls.at(-1).output.includes("FACT-5"));
  assert.equal(JSON.stringify(context.outputs), retained);
  assert.equal(JSON.stringify(state).includes("fixture-budget-secret"), false);
  assert.deepEqual(context.stats(state).truncatedToolCalls,
    state.recentToolCalls.filter((call) => call.truncation.output).length);
});

test("zero and single-character budgets omit content while positive previews preserve both ends", () => {
  const context = new Context();
  assert.deepEqual(context.bounded("healthy", 7), { text: "healthy", truncated: false });
  assert.deepEqual(context.bounded("healthy", 4), { text: "he\n[truncated]\nhy", truncated: true });
  for (const limit of [0, 1])
    assert.deepEqual(context.bounded("healthy", limit), { text: "\n[truncated]\n", truncated: true });
  assert.deepEqual(context.bounded("", 0), { text: "", truncated: false });
});

test("a crowded context can omit older previews without restoring their full outputs", async () => {
  const context = new Context();
  context.reset("\0".repeat(1000));
  for (let index = 0; index < 3; index++)
    context.add({
      type: "message",
      role: "assistant",
      phase: "commentary",
      content: [{ type: "output_text", text: "\0".repeat(750) }],
    });
  for (let index = 0; index < 6; index++)
    context.addHook({
      tool_use_id: `crowded-${index}`,
      tool_name: "read",
      tool_input: "\0".repeat(1800),
      tool_response: "x".repeat(10000),
    });
  const retained = JSON.stringify(context.outputs);
  const state = context.state({ supportedEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"] });
  assert.ok(Buffer.byteLength(JSON.stringify(state)) <= 96 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(decisionRequest(state))) < 128 * 1024);
  assert.equal(state.recentToolCalls[0].output, "\n[truncated]\n");
  assert.ok(state.recentToolCalls.at(-1).output.includes("x"));
  assert.equal(JSON.stringify(context.outputs), retained);
  const requests = [];
  const jev = new Jev({
    key: "fixture-crowded-key",
    fetchImpl: async (_, options) => {
      requests.push(JSON.parse(options.body));
      return new Response(JSON.stringify({
        model: "jev-1.13.0",
        answers: {
          effort: { type: "choice", choice: "low" },
          lease: { type: "choice", choice: "1" },
        },
      }));
    },
  });
  assert.equal((await jev.decide(state)).effort, "low");
  assert.equal(requests.length, 1);
  assert.equal(JSON.stringify(requests[0].state), JSON.stringify(state));
});

test("truncated tool previews retain bounded redacted middle diagnostics and turn provenance", () => {
  const context = new Context({ secrets: ["fixture-sensitive-key"] });
  context.reset("Install tools");
  const output =
    "Package metadata\n".repeat(3000) +
    "Dependency conflict: stable tool requires framework <=7.\nCurrent framework is 8. Preserve existing lock-file edits.\napi_key=fixture-sensitive-key\n" +
    "More package metadata\n".repeat(3000);
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
    tool_response: "Warning: fixture detail\n".repeat(10000),
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
      tool_response: "x".repeat(30000),
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
