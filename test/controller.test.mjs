import test from "node:test";
import assert from "node:assert/strict";
import { Controller } from "../src/controller.mjs";
import { Context } from "../src/context.mjs";

const choices = ["low", "medium", "high"];
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
function setup(
  decisions = [
    { effort: "low", leaseSteps: 1 },
    { effort: "high", leaseSteps: 2 },
  ],
) {
  const logs = [],
    calls = [];
  let n = 0;
  const c = new Controller({
    supportedEfforts: choices,
    context: new Context(),
    jev: {
      decide: async () => {
        const d = decisions[n++];
        if (d instanceof Error) throw d;
        return await d;
      },
    },
    rpc: async (method, params) => {
      calls.push({ method, params });
      return { status: "applied" };
    },
    record: (x) => logs.push(x),
  });
  return { c, logs, calls };
}
const raw = (c, item) =>
  c.handle("rawResponseItem/completed", {
    threadId: "thread-a",
    turnId: "turn-a",
    item,
  });
const complete = (c, id) =>
  c.handle("rawResponse/completed", {
    threadId: "thread-a",
    turnId: "turn-a",
    responseId: id,
    usage: { totalTokens: 10 },
  });
async function start(c) {
  assert.equal(
    await c.begin({
      threadId: "thread-a",
      prompt: "Synthetic task",
      defaultEffort: "medium",
    }),
    "low",
  );
  c.attach("turn-a");
  await raw(c, { type: "configuration_update", reasoning: { effort: "low" } });
}

test("publishing high does not label it captured until the native configuration event arrives", async () => {
  const { c, logs, calls } = setup();
  await start(c);
  await raw(c, {
    type: "function_call",
    call_id: "call-a",
    name: "read",
    arguments: "{}",
  });
  await complete(c, "response-1");
  await raw(c, {
    type: "function_call_output",
    call_id: "call-a",
    output: "Material unresolved dependency",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params.effort, "high");
  assert.equal(c.capturedEffort, "low");
  assert.equal(
    logs.filter((x) => x.type === "effort_captured" && x.effort === "high")
      .length,
    0,
  );
  await raw(c, { type: "configuration_update", reasoning: { effort: "high" } });
  assert.equal(c.capturedEffort, "high");
  await complete(c, "response-2");
  assert.equal(
    logs.find(
      (x) => x.type === "generation_completed" && x.responseId === "response-2",
    ).effort,
    "high",
  );
});

test("generation leases ignore duplicate response IDs and parallel tool outputs", async () => {
  const { c, calls } = setup([
    { effort: "low", leaseSteps: 2 },
    { effort: "high", leaseSteps: 1 },
  ]);
  await start(c);
  for (const id of ["one", "two"])
    await raw(c, {
      type: "function_call",
      call_id: id,
      name: "read",
      arguments: "{}",
    });
  await complete(c, "r1");
  await complete(c, "r1");
  await raw(c, { type: "function_call_output", call_id: "one", output: "OK" });
  await raw(c, { type: "function_call_output", call_id: "two", output: "OK" });
  assert.equal(calls.length, 0);
  assert.equal(c.completedGenerations, 1);
  await complete(c, "r2");
  await raw(c, {
    type: "function_call_output",
    call_id: "three",
    output: "OK",
  });
  assert.equal(calls.length, 1);
});

test("late Jev replies never update a completed or replaced turn", async () => {
  const d = deferred();
  const { c, calls, logs } = setup([
    { effort: "low", leaseSteps: 1 },
    d.promise,
  ]);
  await start(c);
  await complete(c, "r1");
  const pending = raw(c, {
    type: "function_call_output",
    call_id: "x",
    output: "OK",
  });
  await c.handle("turn/completed", {
    threadId: "thread-a",
    turn: { id: "turn-a", status: "completed" },
  });
  d.resolve({ effort: "high", leaseSteps: 1 });
  await pending;
  assert.equal(calls.length, 0);
  assert.equal(c.capturedEffort, "low");
  assert.ok(logs.some((x) => x.type === "decision_discarded"));
});

test("provider failure preserves captured effort and does not publish guessed choices", async () => {
  const { c, calls, logs } = setup([
    { effort: "low", leaseSteps: 1 },
    new Error("provider unavailable"),
  ]);
  await start(c);
  await complete(c, "r1");
  await raw(c, { type: "function_call_output", call_id: "x", output: "OK" });
  assert.equal(c.capturedEffort, "low");
  assert.equal(calls.length, 0);
  assert.ok(logs.some((x) => x.type === "evaluation_failed"));
});

test("unavailable update is not captured and rejected effort is never sent", async () => {
  const { c, calls, logs } = setup();
  await start(c);
  c.rpc = async () => ({ status: "targetUnavailable" });
  await complete(c, "r1");
  await raw(c, { type: "function_call_output", call_id: "x", output: "OK" });
  assert.equal(c.capturedEffort, "low");
  assert.ok(logs.some((x) => x.type === "update_unavailable"));
  const other = setup([{ effort: "none", leaseSteps: 1 }]);
  assert.equal(
    await other.c.begin({
      threadId: "thread-a",
      prompt: "test",
      defaultEffort: "medium",
    }),
    "medium",
  );
  assert.equal(other.calls.length, 0);
});

test("foreign thread events and tool failures in another thread leave the turn untouched", async () => {
  const { c, calls } = setup();
  await start(c);
  await c.handle("rawResponseItem/completed", {
    threadId: "other",
    turnId: "turn-a",
    item: { type: "configuration_update", reasoning: { effort: "high" } },
  });
  await c.handle("rawResponse/completed", {
    threadId: "thread-a",
    turnId: "other",
    responseId: "r1",
  });
  assert.equal(c.capturedEffort, "low");
  assert.equal(c.completedGenerations, 0);
  assert.equal(calls.length, 0);
});

test("a delayed capture is reported as late rather than assigned to an earlier generation", async () => {
  const { c, logs } = setup();
  await start(c);
  await complete(c, "r1");
  await raw(c, { type: "function_call_output", call_id: "x", output: "OK" });
  await complete(c, "r2");
  await raw(c, { type: "configuration_update", reasoning: { effort: "high" } });
  assert.equal(
    logs.find((x) => x.type === "generation_completed" && x.responseId === "r2")
      .effort,
    "low",
  );
  const capture = logs.find(
    (x) => x.type === "effort_captured" && x.effort === "high",
  );
  assert.equal(capture.generation, 3);
  assert.equal(capture.lateBy, 1);
});

test("interrupting the initial Jev decision never starts a fallback turn", async () => {
  const d = deferred(),
    { c } = setup([d.promise]);
  const initial = c.begin({
    threadId: "thread-a",
    prompt: "Synthetic",
    defaultEffort: "medium",
  });
  c.stop();
  d.resolve({ effort: "high", leaseSteps: 1 });
  await assert.rejects(() => initial, /cancelled/);
});
