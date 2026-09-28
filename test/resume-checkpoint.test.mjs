import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Session } from "../src/session.mjs";
import { AppServer } from "../src/app-server.mjs";
import { Controller } from "../src/controller.mjs";
import { statusLines } from "../src/status.mjs";
import { Context } from "../src/context.mjs";

for (const fixed of [false, true])
  test(`resumed checkpoint changes native continuation without raw events (${fixed ? "fixed control" : "adaptive"})`, async () => {
    const records = [],
      states = [];
    const transport = new AppServer({
      spawnImpl: (_, args, opts) =>
        spawn(
          process.execPath,
          [
            fileURLToPath(
              new URL("../fixtures/checkpoint-server.mjs", import.meta.url),
            ),
            ...args,
          ],
          opts,
        ),
    });
    const session = new Session({
      transport,
      fixedEffort: fixed ? "low" : null,
      record: (e) => records.push(e),
      jev: {
        decide: async (state) => {
          states.push(state);
          return { effort: states.length % 2 ? "low" : "high", leaseSteps: 10 };
        },
      },
    });
    try {
      await session.open({ resume: "thread-checkpoint" });
      const result = await session.run("Read synthetic evidence");
      assert.equal(result.status, "completed");
      assert.equal(
        result.text,
        fixed ? "CONTINUATION_LOW" : "CONTINUATION_HIGH",
      );
      assert.equal(states.length, fixed ? 0 : 2);
      assert.equal(session.controller.capturedEffort, null);
      assert.equal(
        records.filter((e) => e.type === "generation_completed").length,
        0,
      );
      assert.equal(
        records.filter((e) => e.type === "effort_captured").length,
        0,
      );
      if (!fixed) {
        assert.equal(session.mode, "adaptive-resume");
        assert.equal(states[1].step, null);
        assert.equal(
          states[1].recentToolCalls[0].output,
          "New complex evidence",
        );
        assert.equal(
          records.find((e) => e.type === "update_published").targetGeneration,
          null,
        );
        assert.equal(session.status().phase, "completed");
        assert.equal(session.status().captureAvailable, false);
        assert.equal(session.status().leaseApplied, false);
        assert.match(
          statusLines(session.status()).join("\n"),
          /generation count unavailable/,
        );
        assert.doesNotMatch(
          statusLines(session.status()).join("\n"),
          /waiting for capture|ADAPTIVE.*PER-TURN/,
        );
      }
    } finally {
      await session.close();
    }
  });

const hook = (id) => ({
  session_id: "t",
  turn_id: "u",
  tool_use_id: id,
  tool_name: "Bash",
  tool_input: { command: "synthetic" },
  tool_response: `result ${id}; password=private-test`,
});
async function resumed(
  decide,
  rpc = async () => ({ status: "applied" }),
  extra = {},
) {
  const logs = [],
    updates = [];
  let decisions = 0;
  const c = new Controller({
    gated: true,
    captureEvents: false,
    supportedEfforts: ["low", "high"],
    context: new Context({ secrets: ["private-test"] }),
    record: (e) => logs.push(e),
    jev: {
      decide: async (s, o) =>
        ++decisions === 1 ? { effort: "low", leaseSteps: 10 } : decide(s, o),
    },
    rpc: async (m, p, o) => {
      updates.push(p);
      return rpc(m, p, o);
    },
    ...extra,
  });
  await c.begin({
    threadId: "t",
    prompt: "Synthetic task",
    defaultEffort: "low",
  });
  c.attach("u");
  return { c, logs, updates };
}
test("resumed checkpoints reassess changing evidence, keep duplicates silent, and never invent captures or generation leases", async () => {
  const states = [];
  const f = await resumed(async (s) => {
    states.push(s);
    return { effort: states.length === 1 ? "high" : "low", leaseSteps: 10 };
  });
  await f.c.handle("item/completed", {
    threadId: "t",
    turnId: "u",
    item: { type: "agentMessage", phase: "commentary", text: "Public finding" },
  });
  await f.c.handle("item/completed", {
    threadId: "t",
    turnId: "u",
    item: { type: "reasoning", text: "private reasoning" },
  });
  await f.c.checkpoint(hook("a"));
  await f.c.checkpoint(hook("a"));
  await f.c.checkpoint(hook("b"));
  assert.deepEqual(
    f.updates.map((x) => x.effort),
    ["high", "low"],
  );
  assert.equal(states.length, 2);
  assert.equal(states[0].step, null);
  assert.equal(states[1].previousEffort, "high");
  assert.deepEqual(states[0].publicNotes, ["Public finding"]);
  assert.doesNotMatch(JSON.stringify(states), /private-test|private reasoning/);
  assert.equal(f.c.completedGenerations, 0);
  assert.equal(f.c.capturedEffort, null);
  assert.equal(f.c.pending, null);
  assert.equal(
    f.logs.filter((e) => e.type === "checkpoint_released").length,
    2,
  );
});
test("resumed parallel checkpoints discard stale evidence before publishing one shared decision", async () => {
  let started, release;
  const began = new Promise((r) => (started = r)),
    blocked = new Promise((r) => (release = r));
  const states = [];
  const f = await resumed(async (s) => {
    states.push(s);
    if (states.length === 1) {
      started();
      await blocked;
    }
    return { effort: states.length === 1 ? "low" : "high", leaseSteps: 10 };
  });
  const a = f.c.checkpoint(hook("a"));
  await began;
  const b = f.c.checkpoint(hook("b"));
  const duplicate = f.c.checkpoint(hook("a"));
  release();
  await Promise.all([a, b, duplicate]);
  assert.equal(states.length, 2);
  assert.equal(states[1].recentToolCalls.length, 2);
  assert.deepEqual(
    f.updates.map((x) => x.effort),
    ["high"],
  );
  assert.equal(f.logs.filter((e) => e.type === "decision_discarded").length, 1);
});
test("resumed cancelled evaluation cannot publish after interruption", async () => {
  let started, release;
  const began = new Promise((r) => (started = r)),
    blocked = new Promise((r) => (release = r));
  const f = await resumed(async () => {
    started();
    await blocked;
    return { effort: "high", leaseSteps: 1 };
  });
  const checkpoint = f.c.checkpoint(hook("a"));
  await began;
  f.c.stop();
  release();
  await assert.rejects(checkpoint, /cancelled/);
  assert.deepEqual(f.updates, []);
});
test("resumed publication failures never become captured or retained decisions", async () => {
  let stopped = 0;
  const f = await resumed(
    async () => ({ effort: "high", leaseSteps: 1 }),
    async () => {
      throw Error("synthetic timeout");
    },
    {
      onFatal: async () => {
        stopped++;
      },
    },
  );
  await assert.rejects(f.c.checkpoint(hook("a")), /cancelled/);
  assert.equal(stopped, 1);
  assert.equal(f.c.active, false);
  assert.equal(f.c.capturedEffort, null);
  assert.equal(f.logs.filter((e) => e.type === "update_published").length, 0);
});

test("resumed evidence arriving during publication is assessed before either checkpoint releases", async () => {
  let publishing, release;
  const started = new Promise((r) => (publishing = r));
  const blocked = new Promise((r) => (release = r));
  const states = [];
  const f = await resumed(
    async (state) => {
      states.push(state);
      return { effort: states.length === 1 ? "high" : "low", leaseSteps: 1 };
    },
    async () => {
      publishing();
      await blocked;
      return { status: "applied" };
    },
  );
  const first = f.c.checkpoint(hook("a"));
  await started;
  const second = f.c.checkpoint(hook("b"));
  release();
  await Promise.all([first, second]);
  assert.equal(states.length, 2);
  assert.equal(states[1].recentToolCalls.length, 2);
  assert.deepEqual(
    f.updates.map((x) => x.effort),
    ["high", "low"],
  );
  assert.equal(
    f.logs.findIndex((e) => e.type === "checkpoint_released") >
      f.logs.findIndex(
        (e) => e.type === "update_published" && e.effort === "low",
      ),
    true,
  );
});
