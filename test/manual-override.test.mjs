import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Session } from "../src/session.mjs";
import { statusLines } from "../src/status.mjs";

function fixture(options = {}) {
  const transport = new EventEmitter();
  transport.request = async () => ({ status: "applied" });
  const events = [];
  const session = new Session({
    transport,
    record: (e) => events.push(e),
    ...options,
  });
  session.threadId = "owned";
  session.selectedModel = "gpt-6-astra";
  session.running = true;
  session.controller = {
    revision: 0,
    requestedEffort: "low",
    active: true,
    stop() {
      this.active = false;
    },
    suspend() {
      this.revision++;
      this.inFlight = null;
    },
  };
  return { session, events, transport };
}

test("manual effort pauses once and queues explicit enable until the next turn", async () => {
  const { session, events } = fixture();
  await session.updateSettings({ effort: "high" }, "turn/settings/update");
  assert.equal(session.jevPaused, true);
  assert.equal(session.manualEffort, "high");
  assert.match(statusLines(session.status()).join("\n"), /Manual effort: high/);
  await session.checkpoint({});
  await session.updateSettings({ effort: "medium" }, "turn/settings/update");
  assert.equal(events.filter((e) => e.type === "jev_policy_notice").length, 1);
  assert.match(
    events.find((e) => e.type === "jev_policy_notice").message,
    /manual effort change.*\$astra-jev enable/,
  );
  assert.equal(session.enableJev().enablePending, true);
  assert.equal(session.jevPaused, true);
  session.running = false;
  session.enableJev();
  assert.equal(session.jevPaused, false);
  assert.equal(session.manualEffort, null);
});

test("switching back to Astra keeps Jev paused", async () => {
  const { session } = fixture();
  await session.updateSettings({ model: "gpt-6-sol" });
  await assert.rejects(async () => session.enableJev(), /Select Astra/);
  await session.updateSettings({ model: "gpt-6-astra" });
  assert.equal(session.jevPaused, true);
});

test("manual publication waits for an outstanding Jev publication", async () => {
  const { session } = fixture();
  let release;
  session.controller.publication = new Promise((r) => (release = r));
  const calls = [];
  session.transport.request = async (_, p) => {
    calls.push(p);
    return { status: "applied" };
  };
  const update = session.updateSettings(
    { effort: "high" },
    "turn/settings/update",
  );
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.length, 0);
  release();
  await update;
  assert.deepEqual(calls, [{ effort: "high" }]);
});

test("manual settings do not wait for a cancelled evaluator or pause after rejection", async () => {
  const { session, transport } = fixture();
  session.controller.inFlight = new Promise(() => {});
  await session.updateSettings({ effort: "high" }, "turn/settings/update");
  assert.equal(session.jevPaused, true);

  const rejected = fixture();
  rejected.transport.request = async () => ({ status: "unavailable" });
  await assert.rejects(
    () =>
      rejected.session.updateSettings(
        { effort: "high" },
        "turn/settings/update",
      ),
    /not applied; Astra-Jev remains active/,
  );
  assert.equal(rejected.session.jevPaused, undefined);
  assert.equal(rejected.session.manualSettingPending, false);
  assert.equal(rejected.session.controller.active, true);
  assert.equal(rejected.session.status().policy, "auto");
  assert.equal(transport.listenerCount("notification"), 1);
});

test("fixed and required Jev sessions keep their declared control boundaries", async () => {
  const fixed = fixture({ fixedEffort: "high" });
  await fixed.session.updateSettings({ effort: "low" }, "turn/settings/update");
  assert.equal(fixed.session.jevPaused, undefined);
  assert.throws(
    () => fixed.session.enableJev(),
    /Restart without fixed effort/,
  );

  const required = fixture({ requireJev: true });
  await assert.rejects(
    () =>
      required.session.updateSettings(
        { effort: "high" },
        "turn/settings/update",
      ),
    /Jev is required/,
  );
  required.session.running = false;
  required.session.model = {
    supportedReasoningEfforts: [{ reasoningEffort: "high" }],
  };
  assert.equal(required.session.status().policy, "auto");
  assert.throws(() => required.session.setEffort("high"), /Jev is required/);
  assert.equal(required.session.status().policy, "auto");
  assert.equal(required.session.status().jevPaused, false);
});
