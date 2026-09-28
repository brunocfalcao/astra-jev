import test from "node:test";
import assert from "node:assert/strict";
import { EffortNotices } from "../src/effort-notices.mjs";

function setup({ captureEvents = true, verbose = true } = {}) {
  const messages = [];
  const session = {
    threadId: "owned",
    controller: { captureEvents, supportedEfforts: ["low", "medium", "high"] },
  };
  const notices = new EffortNotices({
    session,
    verbose,
    emit: (message) => messages.push(message),
  });
  const event = (type, fields = {}) =>
    notices.handle({ type, threadId: "owned", turnId: "turn-1", ...fields });
  const select = (effort, targetGeneration = 1, fields = {}) =>
    event("decision_selected", {
      effort,
      targetGeneration,
      evaluatedModel: "jev-fixture",
      ...fields,
    });
  const capture = (effort, targetGeneration = 1, fields = {}) =>
    event("effort_captured", { effort, targetGeneration, ...fields });
  const text = () => messages.map((x) => x.params.run.entries[0].text);
  return { notices, messages, event, select, capture, text };
}

test("native effort notices require capture and keep unchanged Jev decisions silent", () => {
  const { messages, event, select, capture, text } = setup();
  event("turn_preparing");
  select("low");
  event("update_published", { effort: "low" });
  assert.deepEqual(text(), []);
  capture("low", 1, { threadId: "foreign" });
  capture("high", null);
  assert.deepEqual(text(), []);
  capture("low");
  capture("low");
  assert.deepEqual(text(), ["Astra changed to LOW effort (Jev)"]);
  select("medium", 2);
  event("update_published", { effort: "medium" });
  assert.equal(messages.length, 1);
  capture("medium", 2);
  select("medium", 3);
  event("effort_retained", { effort: "medium" });
  select("medium", 4);
  event("effort_retained", { effort: "medium" });
  // Same effort at the start of another turn produces no effort_retained event.
  event("turn_preparing", { turnId: null });
  select("medium", 1, { turnId: null });
  assert.deepEqual(text(), [
    "Astra changed to LOW effort (Jev)",
    "Astra changed to MEDIUM effort (Jev)",
  ]);
  assert.equal(new Set(messages.map((m) => m.params.run.id)).size, 2);
  assert.ok(
    messages.every(
      (m) =>
        m.method === "hook/completed" &&
        m.params.threadId === "owned" &&
        m.params.run.source === "unknown",
    ),
  );
});

test("initial, resumed and late captures preserve their evidence level", () => {
  const fresh = setup();
  fresh.select("low");
  fresh.capture("low");
  assert.deepEqual(fresh.text(), ["Astra set to LOW effort (Jev)"]);
  fresh.select("high", 2);
  fresh.capture("high", 2, { lateBy: 1 });
  assert.equal(
    fresh.text()[1],
    "Astra changed to HIGH effort (Jev); captured 1 generation(s) late",
  );
  const resumed = setup({ captureEvents: false });
  resumed.select("high");
  resumed.event("turn_completed");
  resumed.event("turn_preparing");
  resumed.select("low");
  resumed.event("turn_completed");
  resumed.event("turn_preparing");
  resumed.select("low");
  resumed.event("turn_completed");
  assert.deepEqual(resumed.text(), [
    "Jev selected HIGH effort",
    "Jev selected LOW effort",
  ]);
});

test("failures and cancelled updates never claim an applied Jev change", () => {
  for (const type of [
    "update_failed",
    "update_unavailable",
    "update_unconfirmed",
    "turn_completed",
    "turn_interrupted",
  ]) {
    const { event, select, capture, text, notices } = setup();
    capture("low");
    select("high", 2);
    event(type);
    notices.finish();
    capture("high", 2);
    assert.deepEqual(text(), ["Jev selected HIGH effort; change unconfirmed"]);
  }
  const failed = setup();
  failed.event("evaluation_requested", { targetGeneration: 1 });
  failed.event("evaluation_failed", { reason: "sensitive provider response" });
  failed.select("low", 1, { evaluatedModel: undefined, fallback: true });
  failed.capture("low");
  failed.event("evaluation_failed");
  assert.deepEqual(failed.text(), [
    "Jev unavailable; Astra will use its fallback effort",
    "Jev unavailable; Astra retains LOW effort",
  ]);
});

test("foreign, unsupported and manual choices never become Jev notices", () => {
  const { select, capture, text } = setup();
  select("high", 1, { threadId: "foreign" });
  select("bad\u001b[2J");
  select("low", 1, { evaluatedModel: undefined, source: "manual" });
  capture("low");
  assert.deepEqual(text(), []);
});

test("quiet notices suppress routine decisions while retaining failure evidence", () => {
  const quiet = setup({ verbose: false });
  quiet.select("low");
  quiet.capture("low");
  quiet.select("medium", 2);
  quiet.capture("medium", 2);
  quiet.select("medium", 3);
  quiet.event("turn_completed");
  assert.deepEqual(quiet.text(), []);
  quiet.select("high", 4);
  quiet.event("update_unconfirmed");
  quiet.event("evaluation_failed");
  assert.deepEqual(quiet.text(), [
    "Jev selected HIGH effort; change unconfirmed",
    "Jev unavailable; Astra retains MEDIUM effort",
  ]);
  const resumed = setup({ captureEvents: false, verbose: false });
  resumed.select("high");
  resumed.event("turn_completed");
  assert.deepEqual(resumed.text(), []);
});

test("normal turns never emit mode or permission banners", () => {
  const messages = [];
  const session = {
    threadId: "owned",
    mode: "turn-only-resume",
    controller: { captureEvents: false, supportedEfforts: ["medium"] },
    status: () => ({
      mode: "turn-only-resume",
      policy: "auto",
      sandbox: "dangerFullAccess",
    }),
  };
  const notices = new EffortNotices({
    session,
    emit: (message) => messages.push(message.params.run.entries[0].text),
  });
  for (let turn = 0; turn < 3; turn++) {
    notices.handle({ type: "turn_preparing", threadId: "owned" });
    notices.handle({
      type: "decision_selected",
      threadId: "owned",
      effort: "medium",
      targetGeneration: 1,
      evaluatedModel: "jev-fixture",
    });
    notices.handle({ type: "turn_completed", threadId: "owned" });
  }
  assert.deepEqual(messages, ["Jev selected MEDIUM effort"]);
});

test("resumed mid-turn notices wait for publication and do not claim capture", () => {
  const f = setup({ captureEvents: false });
  f.select("low");
  f.select("high", null);
  assert.deepEqual(f.text(), ["Jev selected LOW effort"]);
  f.event("update_published", { effort: "high", targetGeneration: null });
  assert.deepEqual(f.text(), [
    "Jev selected LOW effort",
    "Jev selected HIGH effort for the next step",
  ]);
  f.select("high", null);
  f.event("effort_retained", { effort: "high" });
  assert.equal(f.text().length, 2);
  f.select("medium", null);
  f.event("update_unavailable");
  assert.equal(f.text()[2], "Jev selected MEDIUM effort; change unconfirmed");
  const quiet = setup({ captureEvents: false, verbose: false });
  quiet.select("high", null);
  quiet.event("update_published", { effort: "high", targetGeneration: null });
  assert.deepEqual(quiet.text(), []);
});
