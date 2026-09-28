import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Session } from "../src/session.mjs";
import { AppServer } from "../src/app-server.mjs";
import { Controller } from "../src/controller.mjs";
import { Context } from "../src/context.mjs";
import { HookBridge, callBridge } from "../src/hook-bridge.mjs";
import { stat, access } from "node:fs/promises";

for (const fixed of [false, true])
  test(`slow Jev is captured before native continuation (${fixed ? "fixed control" : "adaptive"})`, async () => {
    const records = [];
    let decisions = 0;
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
    const s = new Session({
      transport,
      fixedEffort: fixed ? "high" : null,
      jev: {
        decide: async () => {
          if (++decisions === 1) return { effort: "low", leaseSteps: 1 };
          await delay(80);
          return { effort: "high", leaseSteps: 1 };
        },
      },
      record: (x) => records.push(x),
    });
    try {
      await s.open();
      const result = await s.run("Read synthetic evidence and finish");
      assert.equal(result.text, "CHECKPOINT_OK");
      assert.deepEqual(
        records
          .filter((x) => x.type === "generation_completed")
          .map((x) => x.effort),
        fixed ? ["high", "high"] : ["low", "high"],
      );
      assert.equal(
        records.filter((x) => x.type === "update_unconfirmed").length,
        0,
      );
    } finally {
      await s.close();
    }
  });

function gated(evaluator) {
  const logs = [],
    updates = [];
  let count = 0;
  const c = new Controller({
    gated: true,
    supportedEfforts: ["low", "high"],
    context: new Context({ secrets: ["synthetic-secret"] }),
    jev: {
      decide: async (state, options) =>
        ++count === 1
          ? { effort: "low", leaseSteps: 1 }
          : evaluator(state, options),
    },
    rpc: async (_, p) => {
      updates.push(p);
      return { status: "applied" };
    },
    record: (x) => logs.push(x),
  });
  const emit = (method, extra) =>
    c.handle(method, { threadId: "t", turnId: "u", ...extra });
  return {
    c,
    updates,
    logs,
    emit,
    start: async () => {
      await c.begin({
        threadId: "t",
        prompt: "Synthetic",
        defaultEffort: "low",
      });
      c.attach("u");
      await emit("rawResponseItem/completed", {
        item: { type: "configuration_update", reasoning: { effort: "low" } },
      });
    },
  };
}
const hookEvent = (id = "one") => ({
  session_id: "t",
  turn_id: "u",
  tool_use_id: id,
  tool_name: "Bash",
  tool_input: { command: "synthetic read" },
  tool_response: {
    text: "secret=synthetic-secret",
    content: [{ type: "image", data: "private-image" }],
    encrypted_content: "private-reasoning",
  },
});

test("a completed native command with a nonzero exit ends its generation lease", async () => {
  let decisions = 0;
  const f = gated(async () => {
    decisions++;
    return { effort: "high", leaseSteps: 1 };
  });
  await f.start();
  f.c.remaining = 5;
  await f.emit("rawResponse/completed", { responseId: "r1" });
  await f.emit("item/completed", {
    item: { type: "commandExecution", status: "completed", exitCode: 0 },
  });
  assert.equal(f.c.remaining, 4);
  await f.emit("item/completed", {
    item: { type: "commandExecution", status: "completed", exitCode: 2 },
  });
  await f.c.checkpoint(hookEvent());
  assert.equal(decisions, 1);
  assert.deepEqual(
    f.updates.map((x) => x.effort),
    ["high"],
  );
});

test("declined native execution ends the lease without raising effort by itself", async () => {
  let seen;
  const f = gated(async (state) => {
    seen = state;
    return { effort: "low", leaseSteps: 1 };
  });
  await f.start();
  f.c.remaining = 10;
  await f.emit("rawResponse/completed", { responseId: "r1" });
  await f.emit("item/completed", {
    item: {
      id: "declined",
      type: "commandExecution",
      status: "declined",
      exitCode: null,
    },
  });
  await f.c.checkpoint(hookEvent());
  assert.equal(seen.newToolFailures, 1);
  assert.equal(f.c.capturedEffort, "low");
  assert.deepEqual(f.updates, []);
});

test("native trust is scoped to one owned definition and never replaces hook definitions", async () => {
  const b = new HookBridge({ checkpoint: async () => {} });
  const h = {
    server: "astra_jev_checkpoint",
    source: "sessionFlags",
    sourcePath: "/<session-flags>/config.toml",
    displayOrder: 0,
    handlerType: "mcpTool",
    eventName: "postToolUse",
    tool: "checkpoint",
    matcher: ".*",
    timeoutSec: 20,
    enabled: true,
    key: "/<session-flags>/config.toml:post_tool_use:0:0",
    currentHash: "exact-hash",
  };
  const transport = {
    request: async () => ({
      data: [
        {
          hooks: [
            h,
            { server: "unrelated", key: "other", currentHash: "do-not-trust" },
          ],
        },
      ],
    }),
  };
  assert.deepEqual(await b.trustConfig(transport, "/tmp"), {
    "hooks.state": { [h.key]: { trusted_hash: "exact-hash" } },
  });
  h.source = "project";
  await assert.rejects(() => b.trustConfig(transport, "/tmp"), /differs/);
});

test("an inherited checkpoint from another native thread leaves both threads unmanaged by that call", async () => {
  const records = [];
  let decisions = 0;
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
    jev: {
      decide: async () => {
        decisions++;
        return { effort: "low", leaseSteps: 1 };
      },
    },
    record: (x) => records.push(x),
  });
  try {
    await session.open();
    const reply = await callBridge(session.bridge.path, {
      op: "checkpoint",
      params: { ...hookEvent(), session_id: "other-native-thread" },
    });
    assert.equal(reply.ok, true);
    assert.equal(decisions, 0);
    assert.equal(session.controller.capturedEffort, null);
    assert.equal(
      records.filter((x) => x.type === "checkpoint_outside_thread").length,
      1,
    );
    assert.equal(
      (await session.run("Read synthetic fixture")).status,
      "completed",
    );
    assert.equal(decisions, 2);
  } finally {
    await session.close();
  }
});

test("parallel and duplicate checkpoints wait for the issuing generation, share one decision, and sanitize state", async () => {
  let decisions = 0,
    state;
  const f = gated(async (s) => {
    decisions++;
    state = s;
    await delay(10);
    return { effort: "high", leaseSteps: 2 };
  });
  await f.start();
  const a = f.c.checkpoint(hookEvent()),
    b = f.c.checkpoint(hookEvent("two")),
    duplicate = f.c.checkpoint(hookEvent());
  await delay(10);
  assert.equal(decisions, 0);
  assert.deepEqual(f.updates, []);
  await f.emit("rawResponse/completed", { responseId: "r1" });
  await Promise.all([a, b, duplicate]);
  assert.equal(decisions, 1);
  assert.deepEqual(
    f.updates.map((x) => x.effort),
    ["high"],
  );
  assert.equal(f.c.capturedEffort, "low");
  assert.equal(state.recentToolCalls.length, 2);
  assert.doesNotMatch(
    JSON.stringify(state),
    /synthetic-secret|private-image|private-reasoning/,
  );
});

test("checkpoint cancellation and foreign turns cannot publish a delayed Jev result", async () => {
  const f = gated(async () => {
    await delay(30);
    return { effort: "high", leaseSteps: 1 };
  });
  await f.start();
  await assert.rejects(
    () => f.c.checkpoint({ ...hookEvent(), turn_id: "foreign" }),
    /active turn/,
  );
  await f.emit("rawResponse/completed", { responseId: "r1" });
  const abort = new AbortController();
  const p = f.c.checkpoint(hookEvent(), { signal: abort.signal });
  abort.abort();
  await assert.rejects(() => p, /cancelled/);
  assert.deepEqual(f.updates, []);
  assert.equal(f.c.capturedEffort, "low");
});

test("Jev timeout retains effort, while ambiguous native publication stops the turn", async () => {
  const f = gated(async () => {
    throw new Error("Jev timed out");
  });
  await f.start();
  await f.emit("rawResponse/completed", { responseId: "r1" });
  await f.c.checkpoint(hookEvent());
  assert.equal(f.c.active, true);
  assert.equal(f.c.capturedEffort, "low");
  assert.deepEqual(f.updates, []);
  const g = gated(async () => ({ effort: "high", leaseSteps: 1 }));
  let stopped = false;
  g.c.rpc = async () => {
    throw new Error("Codex timed out");
  };
  g.c.onFatal = async () => {
    stopped = true;
  };
  await g.start();
  await g.emit("rawResponse/completed", { responseId: "r1" });
  await assert.rejects(() => g.c.checkpoint(hookEvent()), /cancelled/);
  assert.equal(stopped, true);
  assert.equal(g.c.active, false);
  assert.equal(g.logs.filter((x) => x.type === "evaluation_failed").length, 0);
  assert.equal(g.logs.filter((x) => x.type === "update_failed").length, 1);
});

test("a failure arriving during Jev evaluation cannot acquire a fresh long lease", async () => {
  let resolve;
  const decision = new Promise((r) => {
    resolve = r;
  });
  const f = gated(async () => decision);
  await f.start();
  await f.emit("rawResponse/completed", { responseId: "r1" });
  const waiting = f.c.checkpoint(hookEvent());
  await f.emit("item/completed", {
    item: {
      id: "late-failure",
      type: "commandExecution",
      status: "completed",
      exitCode: 2,
    },
  });
  resolve({ effort: "high", leaseSteps: 10 });
  await waiting;
  await f.emit("rawResponseItem/completed", {
    item: { type: "configuration_update", reasoning: { effort: "high" } },
  });
  assert.equal(f.c.remaining, 0);
});

test("private IPC has bounded lifetime and removes only its owned directory", async () => {
  let failures = 0,
    started;
  const received = new Promise((resolve) => {
    started = resolve;
  });
  const bridge = new HookBridge({
    timeoutMs: 30,
    onFailure: () => failures++,
    checkpoint: (_, { signal }) =>
      new Promise((resolve, reject) => {
        started();
        signal.addEventListener("abort", () => reject(Error("aborted")), {
          once: true,
        });
      }),
  });
  await bridge.open();
  await assert.rejects(() => bridge.waitUntilReady(5), /did not initialize/);
  await callBridge(bridge.path, { op: "ready" });
  await bridge.waitUntilReady(5);
  const path = bridge.directory;
  try {
    assert.equal((await stat(path)).mode & 0o777, 0o700);
    assert.equal((await stat(bridge.path)).mode & 0o777, 0o600);
    const request = callBridge(bridge.path, {
      op: "checkpoint",
      params: hookEvent(),
    });
    const rejected = assert.rejects(() => request, /closed/);
    await received;
    await rejected;
    assert.equal(failures, 1);
  } finally {
    await bridge.close();
  }
  await assert.rejects(() => access(path), /ENOENT/);
});
