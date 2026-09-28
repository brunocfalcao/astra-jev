import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import WebSocket from "ws";
import { AppServer } from "../src/app-server.mjs";
import { Session } from "../src/session.mjs";
import { NativeTui } from "../src/native-tui.mjs";
import { modeLabel, statusLines } from "../src/status.mjs";

function fixture(options = {}, tuiOptions = {}) {
  const requests = [],
    records = [],
    states = [],
    replies = [];
  const transport = new AppServer({
    spawnImpl: (_, args, env) =>
      spawn(
        process.execPath,
        [
          fileURLToPath(
            new URL("../fixtures/checkpoint-server.mjs", import.meta.url),
          ),
          ...args,
        ],
        env,
      ),
  });
  const request = transport.request.bind(transport);
  transport.request = (method, params, rpcOptions) => {
    requests.push({ method, params });
    return request(method, params, rpcOptions);
  };
  const session = new Session({
    transport,
    record: (event) => records.push(event),
    jev: {
      decide: async (state) => {
        states.push(state);
        return { effort: "low", leaseSteps: 1, evaluatedModel: "jev-fixture" };
      },
    },
    ...options,
  });
  const gateway = new NativeTui({ session, ...tuiOptions });
  let id = 0,
    client;
  const pending = new Map();
  const rpc = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const current = ++id;
      pending.set(current, { resolve, reject });
      client.send(JSON.stringify({ id: current, method, params }));
    });
  const turn = async (params) => {
    let listener;
    const completed = new Promise((resolve) => {
      listener = (message) => {
        if (message.method === "turn/completed") resolve(message.params.turn);
      };
      transport.on("notification", listener);
    });
    try {
      await rpc("turn/start", {
        threadId: session.threadId,
        input: [{ type: "text", text: "Synthetic prompt" }],
        ...params,
      });
      return await completed;
    } finally {
      transport.off("notification", listener);
    }
  };
  return {
    session,
    gateway,
    requests,
    records,
    states,
    replies,
    rpc,
    turn,
    open: async ({ resume } = {}) => {
      await session.open({ resume });
      await gateway.open();
      client = new WebSocket(`ws+unix://${gateway.path}:/rpc`);
      await once(client, "open");
      client.on("message", (data) => {
        const message = JSON.parse(data);
        replies.push(message);
        const waiting = pending.get(message.id);
        if (waiting) {
          pending.delete(message.id);
          message.error
            ? waiting.reject(new Error(message.error.message))
            : waiting.resolve(message.result);
        }
      });
      await rpc(
        resume ? "thread/resume" : "thread/start",
        resume ? { threadId: session.threadId } : {},
      );
    },
    close: async () => {
      client?.terminate();
      await gateway.close();
      await session.close();
    },
  };
}

test("Astra to Sol to Astra preserves the thread, native effort and permissions while suspending Jev", async () => {
  const f = fixture({
    threadOptions: { sandbox: "read-only", approvalPolicy: "never" },
  });
  try {
    await f.open();
    const thread = f.session.threadId;
    await f.turn({ model: "gpt-6-astra" });
    assert.equal(f.states.length, 2);
    assert.equal(f.session.status().capturedEffort, "low");
    const native = {
      model: "gpt-6-sol",
      effort: "medium",
      input: [{ type: "text", text: "Only Codex sees this inactive prompt" }],
      sandboxPolicy: { type: "dangerFullAccess" },
      permissions: { fixture: "override" },
    };
    assert.equal((await f.turn(native)).status, "completed");
    assert.equal(f.states.length, 2);
    assert.equal(f.session.running, false);
    assert.equal(f.session.controller.active, false);
    assert.equal(f.session.checkpointFailed, undefined);
    assert.equal(f.session.status().mode, "inactive");
    assert.equal(f.session.status().model, "gpt-6-sol");
    assert.equal(f.session.status().capturedEffort, null);
    assert.match(modeLabel(f.session.status()), /INACTIVE/);
    assert.match(statusLines(f.session.status()).join("\n"), /inactive/i);
    const sent = f.requests
      .filter((r) => r.method === "turn/start")
      .at(-1).params;
    assert.equal(sent.model, "gpt-6-sol");
    assert.equal(sent.effort, "medium");
    assert.deepEqual(sent.input, native.input);
    assert.deepEqual(sent.sandboxPolicy, native.sandboxPolicy);
    assert.equal(sent.approvalPolicy, undefined);
    assert.deepEqual(sent.permissions, native.permissions);
    const decisions = f.records.filter(
      (r) => r.type === "decision_selected",
    ).length;
    await f.turn({}); // Omitted model retains native Sol selection.
    assert.equal(f.states.length, 2);
    assert.equal(
      f.records.filter((r) => r.type === "decision_selected").length,
      decisions,
    );
    await f.turn({ model: "gpt-6-astra", effort: "high" });
    assert.equal(f.session.threadId, thread);
    assert.equal(f.session.mode, "adaptive-checkpoint");
    assert.equal(f.states.length, 4);
    assert.equal(f.session.status().capturedEffort, "low");
    assert.equal(JSON.stringify(f.states).includes("Only Codex sees"), false);
    const notices = f.replies
      .filter((m) => m.method === "hook/completed")
      .flatMap((m) => m.params.run.entries.map((x) => x.text));
    assert.ok(
      notices.some((text) => /Jev inactive for the selected model/.test(text)),
    );
    assert.ok(notices.some((text) => /Jev active.*Astra/.test(text)));
    assert.equal(
      notices.filter((text) => text === "Astra set to LOW effort (Jev)").length,
      2,
    );
  } finally {
    await f.close();
  }
});

test("collaboration model takes precedence and confirmed picker changes update Jev status", async () => {
  const f = fixture();
  try {
    await f.open();
    const mode = {
      mode: "plan",
      settings: {
        model: "gpt-6-sol",
        reasoning_effort: "medium",
        developer_instructions: null,
      },
    };
    await f.rpc("thread/settings/update", {
      threadId: f.session.threadId,
      model: "gpt-6-astra",
      collaborationMode: mode,
    });
    assert.equal(f.session.mode, "inactive");
    assert.equal(f.states.length, 0);
    await f.turn({
      model: "gpt-6-astra",
      effort: "high",
      collaborationMode: mode,
    });
    assert.equal(f.states.length, 0);
    const sent = f.requests
      .filter((r) => r.method === "turn/start")
      .at(-1).params;
    assert.deepEqual(sent.collaborationMode, mode);
    assert.equal(sent.effort, "high");
    await f.rpc("turn/settings/update", {
      threadId: f.session.threadId,
      turnId: "fixture",
      effort: "medium",
    });
    await f.rpc("turn/steer", {
      threadId: f.session.threadId,
      expectedTurnId: "fixture",
      input: [],
    });
    await f.rpc("thread/settings/update", {
      threadId: f.session.threadId,
      model: "gpt-6-astra",
    });
    assert.equal(f.session.mode, "adaptive-checkpoint");
    await assert.rejects(
      () =>
        f.rpc("turn/settings/update", {
          threadId: f.session.threadId,
          effort: "high",
        }),
      /Jev manages effort/,
    );
    await f.turn({
      collaborationMode: {
        ...mode,
        settings: { ...mode.settings, model: "gpt-6-astra" },
      },
    });
    assert.equal(f.states.length, 2);
    const astra = f.requests
      .filter((r) => r.method === "turn/start")
      .at(-1).params;
    assert.equal(astra.collaborationMode.settings.reasoning_effort, "low");
  } finally {
    await f.close();
  }
});

test("required Jev rejects non-Astra selection before changing the backend or evaluating", async () => {
  const f = fixture({ requireJev: true });
  try {
    await f.open();
    const before = f.requests.length;
    for (const method of ["thread/settings/update", "turn/start"])
      await assert.rejects(
        () =>
          f.rpc(method, {
            threadId: f.session.threadId,
            model: "gpt-6-sol",
            input: [],
          }),
        /Jev is required.*Astra/,
      );
    assert.equal(f.requests.length, before);
    assert.equal(f.states.length, 0);
    assert.equal(f.session.mode, "adaptive-checkpoint");
  } finally {
    await f.close();
  }
});

test("resumed and fixed sessions restore their original Astra policy after a model switch", async () => {
  for (const policy of ["resume", "fixed"]) {
    const f = fixture(policy === "fixed" ? { fixedEffort: "high" } : {});
    try {
      await f.open(policy === "resume" ? { resume: "thread-checkpoint" } : {});
      const originalMode = f.session.mode;
      await f.turn({ model: "gpt-6-sol", effort: "medium" });
      assert.equal(f.states.length, 0);
      assert.equal(f.session.mode, "inactive");
      assert.match(modeLabel(f.session.status()), /INACTIVE/);
      await f.turn({ model: "gpt-6-astra" });
      assert.equal(f.session.mode, originalMode);
      assert.equal(f.states.length, policy === "fixed" ? 0 : 2);
      const sent = f.requests
        .filter((r) => r.method === "turn/start")
        .at(-1).params;
      assert.equal(sent.effort, policy === "fixed" ? "high" : "low");
      if (policy === "resume") {
        assert.equal(sent.sandboxPolicy, undefined);
        assert.equal(f.session.controller.captureEvents, false);
        assert.equal(f.session.status().capturedEffort, null);
      }
    } finally {
      await f.close();
    }
  }
});

test("a model picked during an Astra turn applies after completion without stopping its checkpoint", async () => {
  let calls = 0,
    release,
    checkpointReached;
  const checkpoint = new Promise((resolve) => {
    checkpointReached = resolve;
  });
  const f = fixture({
    jev: {
      decide: async () => {
        if (++calls === 2) {
          checkpointReached();
          await new Promise((resolve) => {
            release = resolve;
          });
        }
        return { effort: "low", leaseSteps: 1 };
      },
    },
  });
  try {
    await f.open();
    const running = f.turn({ model: "gpt-6-astra" });
    await checkpoint;
    await f.rpc("thread/settings/update", {
      threadId: f.session.threadId,
      model: "gpt-6-sol",
      effort: "medium",
    });
    assert.equal(f.session.selectedModel, "gpt-6-sol");
    assert.equal(f.session.mode, "adaptive-checkpoint");
    assert.equal(f.session.controller.active, true);
    release();
    assert.equal((await running).status, "completed");
    assert.equal(f.session.mode, "inactive");
    assert.equal(f.session.checkpointFailed, undefined);
    await f.turn({ effort: "medium" });
    assert.equal(calls, 2);
  } finally {
    release?.();
    await f.close();
  }
});

test("a rejected inactive turn releases ownership and can return to Astra", async () => {
  const f = fixture();
  try {
    await f.open();
    const request = f.session.transport.request.bind(f.session.transport);
    f.session.transport.request = (method, params, options) => {
      if (method === "turn/start" && params.model === "missing-model")
        return Promise.reject(new Error("Model unavailable"));
      return request(method, params, options);
    };
    await assert.rejects(
      () => f.turn({ model: "missing-model", effort: "medium" }),
      /Model unavailable/,
    );
    assert.equal(f.states.length, 0);
    assert.equal(f.session.running, false);
    assert.equal(f.session.mode, "adaptive-checkpoint");
    assert.equal(f.session.selectedModel, "gpt-6-astra");
    await f.turn({ model: "gpt-6-astra" });
    assert.equal(f.states.length, 2);
    assert.equal(f.session.mode, "adaptive-checkpoint");
  } finally {
    await f.close();
  }
});

test("inactive notices appear only when leaving Astra, with silent non-Astra turns and switches", async () => {
  const f = fixture();
  const notices = () =>
    f.replies
      .filter((message) => message.method === "hook/completed")
      .flatMap((message) =>
        message.params.run.entries.map((entry) => entry.text),
      );
  const select = (model) =>
    f.rpc("thread/settings/update", {
      threadId: f.session.threadId,
      model,
    });
  const inactive =
    "Jev inactive for the selected model; select Astra to reactivate";
  try {
    await f.open();
    assert.deepEqual(notices(), []);
    await select("gpt-6-sol");
    assert.deepEqual(notices(), [inactive]);
    await f.turn({ effort: "medium" });
    await f.turn({ effort: "medium" });
    assert.deepEqual(notices(), [inactive]);
    await select("gpt-6-luna");
    await f.turn({ effort: "low" });
    assert.deepEqual(notices(), [inactive]);
    assert.equal(f.session.status().mode, "inactive");
    assert.equal(f.states.length, 0);
    await select("gpt-6-astra");
    assert.deepEqual(notices(), [inactive, "Jev active for Astra again"]);
    await select("gpt-6-sol");
    await f.turn({ effort: "medium" });
    assert.deepEqual(notices(), [
      inactive,
      "Jev active for Astra again",
      inactive,
    ]);
    assert.equal(f.states.length, 0);
  } finally {
    await f.close();
  }
});

test("quiet TUI keeps fresh and resumed Jev decisions, status and model-switch notices", async () => {
  for (const resume of [undefined, "fixture-resumed"]) {
    const f = fixture({}, { verbose: false });
    const notices = () =>
      f.replies
        .filter((message) => message.method === "hook/completed")
        .flatMap((message) =>
          message.params.run.entries.map((entry) => entry.text),
        );
    try {
      await f.open({ resume });
      assert.deepEqual(notices(), []);
      assert.equal(f.states.length, 0);
      await f.turn({ model: "gpt-6-astra" });
      await f.turn({ model: "gpt-6-astra" });
      assert.deepEqual(notices(), []);
      const evaluations = 4;
      assert.equal(f.states.length, evaluations);
      assert.equal(
        f.records.filter((event) => event.type === "decision_selected").length,
        evaluations,
      );
      assert.equal(f.session.status().jev, "responding");
      assert.equal(f.session.status().selectedEffort, "low");
      assert.equal(f.session.status().capturedEffort, resume ? null : "low");
      await f.turn({ model: "gpt-6-sol", effort: "medium" });
      await f.turn({ model: "gpt-6-sol", effort: "medium" });
      assert.equal(f.states.length, evaluations);
      assert.deepEqual(notices(), [
        "Jev inactive for the selected model; select Astra to reactivate",
      ]);
      await f.turn({ model: "gpt-6-astra" });
      assert.deepEqual(notices(), [
        "Jev inactive for the selected model; select Astra to reactivate",
        "Jev active for Astra again",
      ]);
      assert.equal(f.states.length, evaluations + 2);
    } finally {
      await f.close();
    }
  }
});

test("completion delivered before the turn-start continuation cannot restore a finished turn ID", async () => {
  for (const model of ["gpt-6-sol", "gpt-6-astra"]) {
    const f = fixture({}, { verbose: false });
    try {
      await f.open({ resume: "fixture-resumed" });
      const request = f.session.transport.request.bind(f.session.transport);
      f.session.transport.request = async (method, params, options) => {
        if (method !== "turn/start") return request(method, params, options);
        let listener;
        const completed = new Promise((resolve) => {
          listener = (message) => {
            if (message.method === "turn/completed") resolve();
          };
          f.session.transport.on("notification", listener);
        });
        try {
          const result = await request(method, params, options);
          // JSONL can deliver a response and all notifications in one chunk,
          // before the caller's awaiting continuation runs.
          await completed;
          return result;
        } finally {
          f.session.transport.off("notification", listener);
        }
      };
      for (let turn = 0; turn < 3; turn++) {
        assert.equal(Boolean(f.session.running), false);
        assert.equal(
          (await f.turn({ model, effort: "medium" })).status,
          "completed",
        );
        assert.equal(f.session.running, false);
        assert.equal(f.session.turnId, null);
      }
      assert.equal(f.states.length, model === "gpt-6-astra" ? 6 : 0);
    } finally {
      await f.close();
    }
  }
});
