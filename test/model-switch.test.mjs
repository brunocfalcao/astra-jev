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
    open: async ({ resume, params, bootstrap = false } = {}) => {
      if (bootstrap) await session.prepare({ resume });
      else await session.open({ resume, params });
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
        resume
          ? { threadId: session.threadId ?? resume, ...params }
          : (params ?? {}),
      );
    },
    close: async () => {
      client?.terminate();
      await gateway.close();
      await session.close();
    },
  };
}

test("manual model changes pause Jev until explicit enable, while initial Astra effort echoes remain adaptive", async () => {
  const f = fixture({
    threadOptions: { sandbox: "read-only", approvalPolicy: "never" },
  });
  try {
    await f.open();
    const thread = f.session.threadId;
    await f.turn({ model: "gpt-6-astra", effort: "high" });
    assert.equal(f.states.length, 2);
    assert.equal(f.session.jevPaused, undefined);
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
    assert.equal(f.session.jevPaused, true);
    assert.equal(f.states.length, 2);
    assert.match(modeLabel(f.session.status()), /PAUSED/);
    assert.match(
      statusLines(f.session.status()).join("\n"),
      /\$astra-jev enable/,
    );
    assert.equal(JSON.stringify(f.states).includes("Only Codex sees"), false);
    const notices = f.replies
      .filter((m) => m.method === "hook/completed")
      .flatMap((m) => m.params.run.entries.map((x) => x.text));
    assert.deepEqual(notices, [
      "Astra-Jev disabled due to a manual model change. To activate it again, type $astra-jev enable in this chat.",
    ]);
    f.session.enableJev();
    await f.turn({ model: "gpt-6-astra" });
    assert.equal(f.states.length, 4);
    assert.equal(f.session.status().capturedEffort, "low");
  } finally {
    await f.close();
  }
});

test("picker choices stay paused across collaboration settings and native turn settings", async () => {
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
    assert.equal(f.session.jevPaused, true);
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
    assert.equal(f.session.jevPaused, true);
    await f.rpc("turn/settings/update", {
      threadId: f.session.threadId,
      effort: "high",
    });
    assert.equal(f.session.manualEffort, "high");
    await f.turn({
      collaborationMode: {
        ...mode,
        settings: { ...mode.settings, model: "gpt-6-astra" },
      },
    });
    assert.equal(f.states.length, 0);
    const astra = f.requests
      .filter((r) => r.method === "turn/start")
      .at(-1).params;
    assert.equal(astra.collaborationMode.settings.reasoning_effort, "high");
    f.session.enableJev();
    await f.turn({ model: "gpt-6-astra" });
    assert.equal(f.states.length, 2);
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

test("required Jev rejects a turn-level managed model change that would pause adaptation", async () => {
  const f = fixture({ requireJev: true });
  try {
    await f.open();
    await f.turn({ model: "gpt-6-astra" });
    const evaluations = f.states.length;
    await assert.rejects(
      () => f.turn({ model: "gpt-6.1-sol" }),
      /Jev is required/,
    );
    assert.equal(f.session.selectedModel, "gpt-6-astra");
    assert.equal(Boolean(f.session.jevPaused), false);
    assert.equal(f.states.length, evaluations);
    assert.equal(
      f.requests.some(
        (r) => r.method === "turn/start" && r.params.model === "gpt-6.1-sol",
      ),
      false,
    );
    await f.turn({ model: "gpt-6-astra" });
    assert.equal(f.states.length, evaluations + 2);
  } finally {
    await f.close();
  }
});

test("resumed sessions require enable after a model switch, while fixed sessions retain fixed effort", async () => {
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
      assert.equal(f.states.length, 0);
      assert.equal(Boolean(f.session.jevPaused), policy === "resume");
      if (policy === "resume") {
        f.session.enableJev();
        await f.turn({ model: "gpt-6-astra" });
        assert.equal(f.states.length, 2);
      }
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

test("a manual model update cancels a slow checkpoint without late Jev publication", async () => {
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
    assert.equal(f.session.jevPaused, true);
    assert.equal(f.session.controller.active, false);
    release();
    assert.equal((await running).status, "completed");
    assert.equal(f.session.mode, "inactive");
    assert.equal(f.session.checkpointFailed, undefined);
    assert.equal(
      f.requests.some((r) => r.method === "turn/settings/update"),
      false,
    );
    await f.turn({ effort: "medium" });
    assert.equal(calls, 2);
    await f.turn({ model: "gpt-6-astra" });
    assert.equal(calls, 2);
    f.session.enableJev();
    await f.turn({ model: "gpt-6-astra" });
    assert.ok(calls > 2);
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

test("manual pause notice appears once and selecting Astra does not reactivate Jev", async () => {
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
  const paused =
    "Astra-Jev disabled due to a manual model change. To activate it again, type $astra-jev enable in this chat.";
  try {
    await f.open();
    assert.deepEqual(notices(), []);
    await select("gpt-6-sol");
    assert.deepEqual(notices(), [paused]);
    await f.turn({ effort: "medium" });
    await f.turn({ effort: "medium" });
    assert.deepEqual(notices(), [paused]);
    await select("gpt-6-luna");
    await f.turn({ effort: "low" });
    assert.deepEqual(notices(), [paused]);
    assert.equal(f.session.status().mode, "inactive");
    assert.equal(f.states.length, 0);
    await select("gpt-6-astra");
    assert.deepEqual(notices(), [paused]);
    assert.equal(f.session.jevPaused, true);
    await select("gpt-6-sol");
    await f.turn({ effort: "medium" });
    assert.deepEqual(notices(), [paused]);
    assert.equal(f.states.length, 0);
  } finally {
    await f.close();
  }
});

test("quiet TUI still shows the manual pause notice and only explicit enable restores Jev", async () => {
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
        "Astra-Jev disabled due to a manual model change. To activate it again, type $astra-jev enable in this chat.",
      ]);
      await f.turn({ model: "gpt-6-astra" });
      assert.deepEqual(notices(), [
        "Astra-Jev disabled due to a manual model change. To activate it again, type $astra-jev enable in this chat.",
      ]);
      assert.equal(f.states.length, evaluations);
      f.session.enableJev();
      await f.turn({ model: "gpt-6-astra" });
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

for (const resume of [undefined, "thread-checkpoint"]) {
  test(`Sol uses adaptive checkpoints with correct evaluator identity (${resume ? "resume" : "fresh"})`, async () => {
    const f = fixture();
    try {
      await f.open({ resume, params: { model: "gpt-6.1-sol" } });
      await f.turn({ model: "gpt-6.1-sol" });
      assert.ok(f.states.length >= 2);
      assert.ok(f.states.every((state) => state.model === "gpt-6.1-sol"));
      assert.equal(f.session.status().model, "gpt-6.1-sol");
      assert.equal(
        f.requests.find((r) => r.method === "turn/start").params.effort,
        "low",
      );
    } finally {
      await f.close();
    }
  });
}

test("native launch detects configured Sol without a model argument", async () => {
  const f = fixture();
  const request = f.session.transport.request.bind(f.session.transport);
  f.session.transport.request = (method, ...args) =>
    method === "config/read"
      ? Promise.resolve({ config: { model: "gpt-6.1-sol" } })
      : request(method, ...args);
  try {
    await f.open({ bootstrap: true });
    assert.equal(f.session.selectedModel, "gpt-6.1-sol");
    assert.equal(Boolean(f.session.jevPaused), false);
    await f.turn({});
    assert.equal(f.states.length, 2);
    assert.ok(f.states.every((state) => state.model === "gpt-6.1-sol"));
  } finally {
    await f.close();
  }
});

test("switching Astra to Sol preserves manual pause and enables Sol evaluation", async () => {
  const f = fixture();
  try {
    await f.open();
    await f.turn({ model: "gpt-6-astra" });
    const before = f.states.length;
    await f.turn({ model: "gpt-6.1-sol" });
    assert.equal(f.states.length, before);
    assert.equal(f.session.jevPaused, true);
    f.session.enableJev();
    await f.turn({ model: "gpt-6.1-sol" });
    assert.ok(f.states.length > before);
    assert.ok(f.states.slice(before).every((s) => s.model === "gpt-6.1-sol"));
  } finally {
    await f.close();
  }
});

for (const resume of [undefined, "thread-checkpoint"]) {
  test(`native bootstrap accepts unmanaged configured model (${resume ? "resume" : "fresh"})`, async () => {
    const f = fixture();
    try {
      await f.open({
        resume,
        bootstrap: true,
        params: { model: "gpt-5.6-sol" },
      });
      assert.equal(f.session.status().model, "gpt-5.6-sol");
      assert.equal(f.session.mode, "inactive");
      await f.turn({ model: "gpt-5.6-sol" });
      assert.equal(f.states.length, 0);
      await f.turn({ model: "gpt-6.1-sol" });
      f.session.enableJev();
      await f.turn({ model: "gpt-6.1-sol" });
      assert.ok(f.states.length > 0);
      assert.ok(f.states.every((state) => state.model === "gpt-6.1-sol"));
    } finally {
      await f.close();
    }
  });
}
