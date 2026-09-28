import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import WebSocket from "ws";
import { AppServer } from "../src/app-server.mjs";
import { Session } from "../src/session.mjs";
import { NativeTui } from "../src/native-tui.mjs";

async function fixture(options = {}) {
  const states = [],
    records = [];
  const transport = new AppServer({
    secrets: ["synthetic-private-value"],
    spawnImpl: (_, args, opts) =>
      spawn(
        process.execPath,
        [
          fileURLToPath(
            new URL("../fixtures/steering-server.mjs", import.meta.url),
          ),
          ...args,
        ],
        opts,
      ),
  });
  const session = new Session({
    transport,
    secrets: ["synthetic-private-value"],
    record: (x) => records.push(x),
    jev: {
      decide: async (state) => {
        states.push(state);
        return { effort: "low", leaseSteps: 10 };
      },
    },
    ...options,
  });
  await session.open({ resume: "owned-steering-thread" });
  const gateway = new NativeTui({ session, verbose: false });
  await gateway.open();
  gateway.attached = true;
  const client = new WebSocket(`ws+unix://${gateway.path}:/rpc`);
  await once(client, "open");
  let next = 0;
  const pending = new Map();
  client.on("message", (data) => {
    const message = JSON.parse(data);
    const resolve = pending.get(message.id);
    if (resolve) {
      pending.delete(message.id);
      resolve(message);
    }
  });
  const message = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++next;
      pending.set(id, resolve);
      client.send(JSON.stringify({ id, method, params }));
    });
  const rpc = async (method, params = {}) => {
    const reply = await message(method, params);
    if (reply.error)
      throw Object.assign(new Error(reply.error.message), {
        rpcError: reply.error,
      });
    return reply.result;
  };
  const turn = (extra = {}) =>
    rpc("turn/start", {
      threadId: session.threadId,
      input: [{ type: "text", text: "Synthetic initial task" }],
      ...extra,
    });
  return {
    session,
    transport,
    states,
    records,
    rpc,
    message,
    turn,
    client,
    close: async () => {
      client.terminate();
      await gateway.close();
      await session.close();
    },
  };
}

test("active resumed skill input reaches Codex unchanged and the next ordinary turn still works", async () => {
  const f = await fixture();
  try {
    const first = await f.turn();
    assert.equal(first.turn.id, "turn-1");
    assert.equal(f.states.length, 1);
    const input = [
      {
        type: "text",
        text: "$astra-jev doctor; password=synthetic-private-value",
      },
      { type: "skill", name: "astra-jev", path: "/synthetic/skill/SKILL.md" },
      { type: "image", url: "data:image/png;base64,synthetic-image-bytes" },
    ];
    const params = {
      threadId: f.session.threadId,
      expectedTurnId: first.turn.id,
      clientUserMessageId: "skill-follow-up",
      input,
      additionalContext: [{ type: "text", text: "native context" }],
    };
    const result = await f.rpc("turn/steer", params);
    assert.equal(result.turnId, first.turn.id);
    assert.deepEqual(result.received, params);
    assert.equal(f.session.running, true);
    assert.equal(
      f.session.controller.context.prompt,
      "$astra-jev doctor; password=[redacted]",
    );
    assert.equal(f.session.controller.context.imageCount, 1);
    assert.equal(
      f.states.length,
      1,
      "accepted steering waits for a supported checkpoint",
    );
    assert.equal(
      JSON.stringify(f.session.controller.context.state()).includes(
        "synthetic-image-bytes",
      ),
      false,
    );
    assert.equal(
      JSON.stringify(f.session.controller.context.state()).includes(
        "/synthetic/skill",
      ),
      false,
    );
    await f.rpc("fixture/finish", { threadId: f.session.threadId });
    assert.equal(f.session.running, false);
    const second = await f.turn({
      input: [{ type: "text", text: "Normal follow-up" }],
    });
    assert.equal(second.turn.id, "turn-2");
    assert.equal(f.states.length, 2);
    assert.ok(JSON.stringify(f.states[1]).includes("$astra-jev doctor"));
    await assert.rejects(
      () => f.rpc("turn/steer", { ...params, threadId: "foreign" }),
      /different owned/,
    );
    assert.equal(f.session.controller.context.prompt, "Normal follow-up");
  } finally {
    await f.close();
  }
});

test("native steering races and review errors keep their RPC identity without accepting rejected context", async () => {
  const f = await fixture();
  try {
    const base = {
      threadId: f.session.threadId,
      expectedTurnId: "stale",
      input: [{ type: "text", text: "Must not enter context" }],
    };
    assert.deepEqual((await f.message("turn/steer", base)).error, {
      code: -32600,
      message: "no active turn to steer",
    });
    await f.turn();
    const before = f.session.controller.context.state();
    assert.deepEqual((await f.message("turn/steer", base)).error, {
      code: -32600,
      message: "expected active turn id `stale` but found `turn-1`",
    });
    await f.rpc("fixture/review", { enabled: true });
    assert.deepEqual(
      (await f.message("turn/steer", { ...base, expectedTurnId: "turn-1" }))
        .error,
      {
        code: -32600,
        message: "active turn does not support steering",
        data: {
          message: "Review input must be queued",
          codexErrorInfo: { activeTurnNotSteerable: { turnKind: "review" } },
        },
      },
    );
    assert.deepEqual(f.session.controller.context.state(), before);
    assert.equal(f.session.running, true);
    assert.equal(f.client.readyState, WebSocket.OPEN);
  } finally {
    await f.close();
  }
});

test("gateway preserves structured native error data while redacting known secrets", async () => {
  const f = await fixture();
  try {
    const reply = await f.message("fixture/error", {
      error: {
        code: -32001,
        message: "Native message synthetic-private-value",
        data: {
          codexErrorInfo: "activeTurnNotSteerable",
          nested: [
            null,
            false,
            7,
            "synthetic-private-value",
            { detail: "unchanged" },
          ],
        },
      },
    });
    assert.deepEqual(reply.error, {
      code: -32001,
      message: "Native message [redacted]",
      data: {
        codexErrorInfo: "activeTurnNotSteerable",
        nested: [null, false, 7, "[redacted]", { detail: "unchanged" }],
      },
    });
    await f.turn();
    assert.equal(f.session.running, true);
  } finally {
    await f.close();
  }
});

test("fixed and inactive models accept native steering without extra Jev calls", async () => {
  for (const variant of ["fixed", "inactive"]) {
    const f = await fixture(variant === "fixed" ? { fixedEffort: "low" } : {});
    try {
      await f.turn(variant === "inactive" ? { model: "gpt-6-sol" } : {});
      const before = f.session.controller.context.state();
      const result = await f.rpc("turn/steer", {
        threadId: f.session.threadId,
        expectedTurnId: "turn-1",
        input: [{ type: "text", text: "Native follow-up" }],
      });
      assert.equal(result.turnId, "turn-1");
      assert.equal(f.states.length, 0);
      if (variant === "inactive")
        assert.deepEqual(f.session.controller.context.state(), before);
      await f.rpc("fixture/finish", { threadId: f.session.threadId });
      assert.equal(f.session.running, false);
    } finally {
      await f.close();
    }
  }
});

test("an accepted steering reply arriving after turn completion cannot revive or contaminate it", async () => {
  const f = await fixture();
  try {
    await f.turn();
    let release, accepted;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const received = new Promise((resolve) => {
      accepted = resolve;
    });
    const request = f.transport.request.bind(f.transport);
    f.transport.request = async (method, params, options) => {
      const result = await request(method, params, options);
      if (method === "turn/steer") {
        accepted();
        await held;
      }
      return result;
    };
    const steering = f.rpc("turn/steer", {
      threadId: f.session.threadId,
      expectedTurnId: "turn-1",
      input: [{ type: "text", text: "Old accepted input" }],
    });
    // On the unmodified gateway, the request is rejected before it reaches the backend.
    const outcome = await Promise.race([
      received.then(() => "accepted"),
      steering.then(
        () => "finished",
        () => "rejected",
      ),
    ]);
    assert.equal(outcome, "accepted");
    await f.rpc("fixture/finish", { threadId: f.session.threadId });
    await f.turn({ input: [{ type: "text", text: "Current task" }] });
    release();
    await steering;
    assert.equal(f.session.turnId, "turn-2");
    assert.equal(f.session.controller.context.prompt, "Current task");
    assert.equal(f.session.running, true);
  } finally {
    await f.close();
  }
});
