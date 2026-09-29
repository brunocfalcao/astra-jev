import test from "node:test";
import assert from "node:assert/strict";
import { UsagePace, usagePace } from "../src/usage-pace.mjs";
import { Session } from "../src/session.mjs";
import { AppServer } from "../src/app-server.mjs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const now = 2_000_000_000_000;
const window = (usedPercent, remaining = 50) => ({
  usedPercent,
  windowDurationMins: 100,
  resetsAt: now / 1000 + remaining * 60,
});
const payload = (used) => ({
  rateLimits: { limitId: "codex", primary: window(used) },
});

test("pace compares allowance with time, including exact boundary and reset", () => {
  assert.equal(usagePace(payload(55).rateLimits, now).state, "above");
  assert.equal(usagePace(payload(50).rateLimits, now).state, "on-or-under");
  assert.equal(usagePace(payload(45).rateLimits, now).state, "on-or-under");
  assert.equal(
    usagePace(payload(55).rateLimits, now + 600_000).state,
    "on-or-under",
  );
  assert.equal(
    usagePace(payload(99).rateLimits, now + 3_000_000).state,
    "unavailable",
  );
  for (const primary of [
    null,
    {},
    window(-1),
    window(101),
    window(NaN),
    window(50, 101),
    { ...window(50), windowDurationMins: 0 },
  ])
    assert.equal(usagePace({ primary }, now).state, "unavailable");
  assert.equal(
    usagePace({ primary: window(20), secondary: window(80) }, now).state,
    "above",
  );
  assert.equal(
    usagePace({ primary: window(0, 100) }, now).state,
    "on-or-under",
  );
});

test("quota refresh uses notifications, ignores unrelated buckets and handles failure", async () => {
  let time = now,
    calls = 0,
    fail = false;
  const monitor = new UsagePace({
    now: () => time,
    request: async () => {
      calls++;
      if (fail) throw Error("unavailable");
      return payload(55);
    },
  });
  assert.equal((await monitor.read()).state, "above");
  await monitor.read();
  assert.equal(calls, 1);
  monitor.update(payload(40));
  monitor.update({
    rateLimits: { limitId: "unrelated", primary: window(100) },
  });
  assert.equal((await monitor.read()).state, "on-or-under");
  time += 60_001;
  fail = true;
  assert.equal((await monitor.read()).state, "unavailable");
  assert.equal(calls, 2);
  monitor.update(payload(55));
  monitor.clear();
  assert.equal(monitor.snapshot().state, "unavailable");
});

test("newer notification wins over an in-flight quota read", async () => {
  let finish;
  const monitor = new UsagePace({
    now: () => now,
    request: () =>
      new Promise((r) => {
        finish = r;
      }),
  });
  const pending = monitor.read();
  monitor.update(payload(40));
  finish(payload(99));
  assert.equal((await pending).state, "on-or-under");
});

test("native session lowers Jev above pace and restores configured adjustment", async () => {
  const records = [];
  const rpc = new AppServer({
    spawnImpl: (_, args, options) =>
      spawn(
        process.execPath,
        [
          fileURLToPath(
            new URL("../fixtures/checkpoint-server.mjs", import.meta.url),
          ),
          ...args,
        ],
        options,
      ),
  });
  const request = rpc.request.bind(rpc);
  rpc.request = (method, ...args) =>
    method === "account/rateLimits/read"
      ? Promise.resolve(payload(55))
      : request(method, ...args);
  const session = new Session({
    transport: rpc,
    effortAdjustment: "optimistic",
    jev: { decide: async () => ({ effort: "high", leaseSteps: 1 }) },
    record: (e) => records.push(e),
  });
  session.usagePace.now = () => now;
  try {
    await session.open();
    await session.run("Synthetic above-pace task");
    let decisions = records.filter((e) => e.type === "decision_selected");
    assert.ok(decisions.length > 0);
    assert.ok(
      decisions.every(
        (e) =>
          e.effort === "low" &&
          e.jevEffort === "high" &&
          e.effortAdjustment === "conservative",
      ),
    );
    records.length = 0;
    await session.notification({
      method: "account/rateLimits/updated",
      params: payload(40),
    });
    await session.run("Synthetic recovered task");
    decisions = records.filter((e) => e.type === "decision_selected");
    assert.ok(
      decisions.every(
        (e) => e.effort === "high" && e.effortAdjustment === "optimistic",
      ),
    );
    assert.equal(session.effortAdjustment, "optimistic");
    session.setEffort("high");
    await session.notification({
      method: "account/rateLimits/updated",
      params: payload(99),
    });
    records.length = 0;
    await session.run("Synthetic manual task");
    assert.equal(
      records.find((e) => e.type === "decision_selected").effort,
      "high",
    );
    assert.equal(
      records.some((e) => e.type === "usage_pace"),
      false,
    );
  } finally {
    await session.close();
  }
});

test("launch notice reaches native fresh and resumed clients once, only above pace", async () => {
  const { NativeTui } = await import("../src/native-tui.mjs");
  for (const resume of [false, true]) {
    for (const used of [55, 50, 40, null]) {
      const rpc = new AppServer({
        spawnImpl: (_, args, options) =>
          spawn(
            process.execPath,
            [
              fileURLToPath(
                new URL("../fixtures/checkpoint-server.mjs", import.meta.url),
              ),
              ...args,
            ],
            options,
          ),
      });
      const request = rpc.request.bind(rpc);
      rpc.request = (method, ...args) =>
        method === "account/rateLimits/read"
          ? Promise.resolve(used === null ? {} : payload(used))
          : request(method, ...args);
      const session = new Session({
        nativeUi: true,
        transport: rpc,
        jev: { decide: async () => ({ effort: "high", leaseSteps: 1 }) },
      });
      session.usagePace.now = () => now;
      const gateway = new NativeTui({ session, verbose: false });
      const sent = [];
      gateway.client = {
        readyState: 1,
        send: (value) => sent.push(JSON.parse(value)),
        terminate() {},
      };
      try {
        await session.prepare({
          resume: resume ? "thread-checkpoint" : undefined,
        });
        gateway.bindSession(session);
        await gateway.receive(
          JSON.stringify({
            id: 1,
            method: resume ? "thread/resume" : "thread/start",
            params: resume ? { threadId: "thread-checkpoint" } : {},
          }),
        );
        assert.ok(sent.some((m) => m.id === 1 && m.result));
        const notices = sent.filter(
          (m) =>
            m.method === "hook/completed" &&
            m.params.run.entries.some((e) =>
              e.text.includes("consumption is above pace"),
            ),
        );
        assert.equal(notices.length, used === 55 ? 1 : 0);
        if (notices.length)
          assert.ok(
            sent.indexOf(notices[0]) > sent.findIndex((m) => m.id === 1),
          );
        assert.equal(await session.paceLaunchNotice(), null);
        if (used === 40) {
          for (const nextUsed of [55, 40, 55]) {
            await session.notification({
              method: "account/rateLimits/updated",
              params: payload(nextUsed),
            });
            await session.run("Synthetic pace transition");
          }
          const later = sent.filter(
            (m) =>
              m.method === "hook/completed" &&
              m.params.run.entries.some((e) =>
                e.text.includes("consumption is above pace"),
              ),
          );
          assert.equal(later.length, 1);
        }
      } finally {
        await session.close();
      }
    }
  }
});

test("pace alerts once across recovery and repeated crossings, including quiet native UI", async () => {
  const { EffortNotices } = await import("../src/effort-notices.mjs");
  const { EventEmitter } = await import("node:events");
  const session = new Session({
    nativeUi: true,
    transport: new EventEmitter(),
  });
  session.threadId = "owned";
  session.controller = { turnId: "turn" };
  const messages = [];
  const notices = new EffortNotices({
    session,
    verbose: false,
    emit: (m) => messages.push(m),
  });
  session.usagePace.now = () => now;
  session.usagePace.update(payload(40));
  assert.equal(await session.paceLaunchNotice(), null);
  for (const used of [55, 55, 40, 55]) {
    const message = session.paceNotice(
      usagePace(payload(used).rateLimits, now),
    );
    if (message)
      notices.handle({ type: "pace_notice", threadId: "owned", message });
  }
  assert.equal(messages.length, 1);
  assert.match(
    messages[0].params.run.entries[0].text,
    /above pace.*conservative/,
  );
});
