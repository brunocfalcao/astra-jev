import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AppServer } from "../src/app-server.mjs";
import { Session } from "../src/session.mjs";
import { HookBridge } from "../src/hook-bridge.mjs";
import { EventEmitter } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";

test("native image input bypasses Jev content and reserves the turn before asynchronous validation", async () => {
  const directory = await mkdtemp("/tmp/astra-jev-images-test-");
  const path = join(directory, "synthetic-image.png");
  await writeFile(path, "fixture-image-bytes");
  const states = [],
    requests = [];
  const transport = new AppServer({
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
  const request = transport.request.bind(transport);
  transport.request = (method, params, options) => {
    requests.push({ method, params });
    return request(method, params, options);
  };
  const session = new Session({
    transport,
    jev: {
      decide: async (s) => {
        states.push(s);
        return { effort: "low", leaseSteps: 1, evaluatedModel: "jev-1.13.0" };
      },
    },
  });
  try {
    await session.open();
    const active = session.run("Describe the image", { images: [path] });
    await assert.rejects(() => session.run("Another turn"), /already running/);
    assert.throws(() => session.setEffort("high"), /between turns/);
    await active;
    assert.deepEqual(
      requests.find((x) => x.method === "turn/start").params.input,
      [
        { type: "text", text: "Describe the image" },
        { type: "localImage", path },
      ],
    );
    assert.equal(states[0].attachments.images, 1);
    assert.equal(states[0].attachments.imageContentVisibleToEvaluator, false);
    assert.equal(JSON.stringify(states).includes(path), false);
    assert.equal(JSON.stringify(states).includes("fixture-image-bytes"), false);
    assert.throws(() => session.setEffort("ultra"), /Unsupported/); // Fixture only supports low/high.
  } finally {
    await session.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("real JSONL process preserves Astra, streams output, observes effort changes and shuts down", async () => {
  const logs = [],
    text = [];
  let invocation;
  let decisions = 0;
  const rpc = new AppServer({
    spawnImpl: (binary, args, options) => {
      invocation = { binary, args, options };
      return spawn(
        process.execPath,
        [
          fileURLToPath(
            new URL("../fixtures/checkpoint-server.mjs", import.meta.url),
          ),
          ...args,
        ],
        options,
      );
    },
  });
  const session = new Session({
    transport: rpc,
    jev: {
      decide: async () =>
        ++decisions === 1
          ? { effort: "low", leaseSteps: 1 }
          : { effort: "high", leaseSteps: 1 },
    },
    record: (x) => logs.push(x),
    onText: (x) => text.push(x),
  });
  try {
    const opened = await session.open();
    assert.equal(opened.mode, "adaptive-checkpoint");
    const result = await session.run("Synthetic fixture");
    assert.equal(result.status, "completed");
    assert.equal(result.text, "CHECKPOINT_OK");
    assert.deepEqual(text, ["CHECKPOINT_OK"]);
    assert.equal(decisions, 2);
    assert.deepEqual(
      logs
        .filter((x) => x.type === "generation_completed")
        .map((x) => x.effort),
      ["low", "high"],
    );
    assert.ok(invocation.args.includes("stdio://"));
    assert.ok(invocation.args.includes("suppress_unstable_features_warning=true"));
    for (const feature of ["shell_snapshot", "shell_snapshot_v2"])
      assert.equal(invocation.args.includes(feature), false);
    assert.equal(invocation.options.shell, false);
    assert.equal(invocation.options.env.TYPESAFE_API_KEY, undefined);
  } finally {
    await session.close();
  }
  assert.equal(rpc.closed, true);
  assert.equal(rpc.pending.size, 0);
});

test("missing Codex executable rejects cleanly without leaving a pending request", async () => {
  const rpc = new AppServer({
    binary: "/nonexistent/astra-jev-fixture",
    timeoutMs: 100,
  });
  await assert.rejects(() => rpc.connect(), /Cannot start|closed/);
  assert.equal(rpc.pending.size, 0);
  await rpc.close();
});

test("stale same-thread events cannot stream text or finish the current turn", async () => {
  const transport = new EventEmitter();
  const text = [],
    completions = [];
  const session = new Session({ transport, onText: (x) => text.push(x) });
  session.threadId = "thread-a";
  session.controller = { turnId: "current", handle: async () => {} };
  session.waiter = { resolve: (x) => completions.push(x) };
  await session.notification({
    method: "item/agentMessage/delta",
    params: { threadId: "thread-a", turnId: "stale", delta: "wrong" },
  });
  await session.notification({
    method: "turn/completed",
    params: {
      threadId: "thread-a",
      turn: { id: "stale", status: "completed" },
    },
  });
  assert.deepEqual(text, []);
  assert.deepEqual(completions, []);
  await session.notification({
    method: "item/agentMessage/delta",
    params: { threadId: "thread-a", turnId: "current", delta: "right" },
  });
  await session.notification({
    method: "turn/completed",
    params: {
      threadId: "thread-a",
      turn: { id: "current", status: "completed" },
    },
  });
  assert.deepEqual(text, ["right"]);
  assert.equal(completions.length, 1);
});

test("only the owned failed native hook stops the active turn and prevents reuse", async () => {
  const transport = new EventEmitter(),
    requests = [],
    records = [];
  transport.request = async (method, params) => {
    requests.push({ method, params });
    return {};
  };
  const session = new Session({ transport, record: (e) => records.push(e) });
  session.bridge = new HookBridge({});
  const hook = {
    server: "astra_jev_checkpoint",
    source: "sessionFlags",
    sourcePath: "/<session-flags>/config.toml",
    displayOrder: 3,
    handlerType: "mcpTool",
    eventName: "postToolUse",
    tool: "checkpoint",
    matcher: ".*",
    timeoutSec: 20,
    enabled: true,
    currentHash: "exact-hash",
    key: "owned",
  };
  await session.bridge.trustConfig(
    { request: async () => ({ data: [{ hooks: [hook] }] }) },
    "/tmp",
  );
  session.threadId = "thread";
  session.turnId = "turn";
  session.running = true;
  session.controller = {
    active: true,
    turnId: "turn",
    handle: async () => {},
    stop() {
      this.active = false;
    },
  };
  const notify = (run, turnId = "turn") =>
    session.notification({
      method: "hook/completed",
      params: {
        threadId: "thread",
        turnId,
        run: { ...hook, status: "failed", ...run },
      },
    });
  await notify({ source: "user" });
  await notify({ displayOrder: 4 });
  await notify({ status: "completed" });
  await notify({}, "stale");
  assert.deepEqual(requests, []);
  await notify({ status: "stopped" });
  assert.deepEqual(requests, [
    {
      method: "turn/interrupt",
      params: { threadId: "thread", turnId: "turn" },
    },
  ]);
  assert.equal(session.controller.active, false);
  assert.ok(records.some((e) => e.type === "checkpoint_failed"));
  session.running = false;
  await assert.rejects(
    () => session.startTurn({ input: [] }),
    /checkpoint.*restart/i,
  );
});
