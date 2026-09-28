import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { once, EventEmitter } from "node:events";
import { stat } from "node:fs/promises";
import { NativeTui } from "../src/native-tui.mjs";
import WebSocket from "ws";
import { Session } from "../src/session.mjs";
import { AppServer } from "../src/app-server.mjs";

test("native TUI gateway uses private IPC and retains Jev control and approval decisions", async () => {
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
  let evaluations = 0;
  const records = [],
    forwarded = [],
    observed = [];
  const turnParams = [];
  const captureRequest = transport.request.bind(transport);
  transport.request = (method, params, options) => {
    if (method === "turn/start") turnParams.push(params);
    return captureRequest(method, params, options);
  };
  const session = new Session({
    transport,
    threadOptions: { sandbox: "read-only", approvalPolicy: "never" },
    record: (x) => records.push(x),
    onEvent: (x) => observed.push(x),
    jev: {
      decide: async () => ({
        effort: ++evaluations % 2 ? "low" : "high",
        leaseSteps: 1,
        evaluatedModel: "jev-fixture",
      }),
    },
  });
  const previousOnEvent = session.onEvent;
  const gateway = new NativeTui({ session, record: (x) => records.push(x) });
  let client;
  try {
    await session.open();
    await gateway.open();
    assert.equal((await stat(gateway.directory)).mode & 0o777, 0o700);
    assert.equal((await stat(gateway.path)).mode & 0o777, 0o600);
    assert.equal(typeof gateway.server.address(), "string");
    client = new WebSocket(`ws+unix://${gateway.path}:/rpc`);
    await once(client, "open");
    let next = 0;
    const pending = new Map();
    let completeTurn;
    const complete = new Promise((resolve) => {
      completeTurn = resolve;
    });
    client.on("message", (data) => {
      const m = JSON.parse(data);
      if (m.method) {
        forwarded.push(m);
        if (m.method === "turn/completed") completeTurn();
        if (m.id)
          client.send(
            JSON.stringify({ id: m.id, result: { decision: "decline" } }),
          );
      } else {
        const p = pending.get(m.id);
        pending.delete(m.id);
        m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
      }
    });
    const rpc = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++next;
        pending.set(id, { resolve, reject });
        client.send(JSON.stringify({ id, method, params }));
      });
    assert.match((await rpc("initialize")).userAgent, /0\.157\.1/);
    assert.equal((await rpc("thread/start", {})).thread.id, session.threadId);
    const backendRequest = transport.request.bind(transport);
    let changedHash = false;
    transport.request = async (method, params, options) => {
      const result = await backendRequest(method, params, options);
      if (method === "hooks/list") {
        const hook = result.data[0].hooks[0];
        result.data[0].hooks.push({
          ...hook,
          key: "unrelated",
          source: "user",
          server: "unrelated",
        });
        if (changedHash) hook.currentHash = "changed-definition";
      }
      return result;
    };
    const hooks = await rpc("hooks/list", { cwds: [process.cwd()] });
    assert.equal(hooks.data[0].hooks[0].trustStatus, "trusted");
    assert.equal(hooks.data[0].hooks[1].trustStatus, "untrusted");
    changedHash = true;
    assert.equal(
      (await rpc("hooks/list", { cwds: [process.cwd()] })).data[0].hooks[0]
        .trustStatus,
      "untrusted",
    );
    changedHash = false;
    await assert.rejects(
      () => rpc("turn/start", { threadId: "foreign", input: [] }),
      /different owned/,
    );
    await assert.rejects(
      () =>
        rpc("turn/start", {
          threadId: session.threadId,
          model: "gpt-6-sol",
          input: [],
        }),
      /Astra only/,
    );
    await assert.rejects(
      () => rpc("turn/steer", { threadId: session.threadId, input: [] }),
      /Interrupt/,
    );
    await rpc("turn/start", {
      threadId: session.threadId,
      input: [{ type: "text", text: "Read synthetic fixture" }],
      sandboxPolicy: { type: "dangerFullAccess" },
      permissions: { fixture: "override" },
    });
    await complete;
    assert.deepEqual(turnParams[0].sandboxPolicy, {
      type: "readOnly",
      networkAccess: false,
    });
    assert.equal(turnParams[0].permissions, undefined);
    assert.deepEqual(
      records
        .filter((x) => x.type === "generation_completed")
        .map((x) => x.effort),
      ["low", "high"],
    );
    assert.equal(
      forwarded.filter((x) => x.method.startsWith("rawResponse")).length,
      0,
    );
    assert.ok(forwarded.some((x) => x.method === "item/agentMessage/delta"));
    const notices = forwarded.filter((x) =>
      x.params?.run?.id?.startsWith("astra-jev-display-"),
    );
    assert.deepEqual(
      notices.map((x) => x.params.run.entries[0].text),
      [
        "Jev mode: ADAPTIVE | Permissions: unknown | Require Jev: off",
        "Astra set to LOW effort (Jev)",
        "Astra changed to HIGH effort (Jev)",
      ],
    );
    assert.equal(
      observed.filter((x) => x.type === "decision_selected").length,
      2,
    );
    for (const effort of ["low", "high"]) {
      const captured = records.findIndex(
        (x) => x.type === "effort_captured" && x.effort === effort,
      );
      const displayed = records.findIndex(
        (x) => x.type === "native_tui_effort_notice" && x.effort === effort,
      );
      assert.ok(captured >= 0 && displayed > captured);
    }
    assert.ok(!JSON.stringify(turnParams).includes("Astra changed"));
    assert.deepEqual(
      await session.onRequest({
        id: 99,
        method: "item/fileChange/requestApproval",
        params: { threadId: session.threadId },
      }),
      { decision: "decline" },
    );
  } finally {
    client?.terminate();
    await gateway.close();
    assert.equal(session.onEvent, previousOnEvent);
    await session.close();
  }
});

test("native TUI shutdown declines pending input and removes its private socket", async () => {
  const transport = new EventEmitter();
  let interrupted = 0;
  const session = {
    transport,
    running: true,
    interrupt: async () => {
      interrupted++;
    },
  };
  const gateway = new NativeTui({ session });
  let client;
  try {
    await gateway.open();
    client = new WebSocket(`ws+unix://${gateway.path}:/rpc`);
    await once(client, "open");
    const waiting = session.onRequest({
      id: 1,
      method: "item/fileChange/requestApproval",
      params: {},
    });
    assert.equal(gateway.pending.size, 1);
    const disconnected = once(client, "close");
    transport.emit("closed");
    await gateway.close();
    await disconnected;
    assert.equal(await waiting, undefined);
    assert.equal(gateway.pending.size, 0);
    assert.equal(gateway.backendFailed, true);
    assert.equal(interrupted, 1);
    assert.equal(transport.listenerCount("notification"), 0);
    assert.equal(transport.listenerCount("closed"), 0);
    await assert.rejects(() => stat(gateway.directory), { code: "ENOENT" });
    await gateway.close();
  } finally {
    client?.terminate();
    await gateway.close();
  }
});

test("deferred resume lets Codex inspect candidates and opens only the selected thread", async () => {
  const transport = new EventEmitter();
  transport.config = [];
  transport.connect = async () => ({ userAgent: "astra_jev/0.157.1 fixture" });
  transport.close = async () => {};
  const requests = [];
  transport.request = async (method, params) => {
    requests.push({ method, params });
    if (method === "model/list")
      return {
        data: [
          {
            model: "gpt-6-astra",
            defaultReasoningEffort: "high",
            supportedReasoningEfforts: [{ reasoningEffort: "high" }],
          },
        ],
      };
    if (method === "thread/read") return { thread: { id: params.threadId } };
    if (method === "thread/resume")
      return {
        model: "gpt-6-astra",
        thread: { id: params.threadId, turns: [] },
        sandbox: { type: "readOnly" },
      };
    return {};
  };
  const session = new Session({
    transport,
    jev: { decide: async () => ({ effort: "high", leaseSteps: 1 }) },
  });
  let opened;
  const gateway = new NativeTui({
    session,
    onOpen: (info) => {
      opened = info;
    },
  });
  const responses = [];
  try {
    await session.prepare({ resume: true });
    assert.equal(session.threadId, undefined);
    assert.equal(
      requests.some((x) => x.method.startsWith("thread/")),
      false,
    );
    await gateway.open();
    gateway.send = (value) => responses.push(value);
    const rpc = async (method, params) => {
      await gateway.receive(
        Buffer.from(
          JSON.stringify({ id: responses.length + 1, method, params }),
        ),
      );
      return responses.at(-1);
    };
    assert.equal(
      (await rpc("thread/read", { threadId: "candidate" })).result.thread.id,
      "candidate",
    );
    assert.equal(session.threadId, undefined);
    const selected = await rpc("thread/resume", {
      threadId: "selected",
      cwd: "/project",
      config: { web_search: "disabled" },
    });
    assert.equal(selected.result.thread.id, "selected");
    assert.equal(session.threadId, "selected");
    assert.equal(opened.mode, "turn-only-resume");
    assert.equal(session.controller.captureEvents, false);
    assert.deepEqual(
      requests.find((x) => x.method === "thread/resume").params,
      {
        threadId: "selected",
        cwd: "/project",
        model: "gpt-6-astra",
        config: { web_search: "disabled" },
        sandbox: "read-only",
        approvalPolicy: "never",
      },
    );
    assert.match(
      (await rpc("thread/resume", { threadId: "foreign" })).error.message,
      /different owned/,
    );
    assert.equal(
      requests.filter((x) => x.method === "thread/resume").length,
      1,
    );
  } finally {
    await gateway.close();
    await session.close();
  }
});

test("deferred fresh start preserves native sandbox and configuration before Jev runs", async () => {
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
  const requests = [];
  const request = transport.request.bind(transport);
  transport.request = (method, params, options) => {
    requests.push({ method, params });
    return request(method, params, options);
  };
  const session = new Session({
    transport,
    jev: { decide: async () => ({ effort: "low", leaseSteps: 1 }) },
  });
  const gateway = new NativeTui({ session });
  try {
    await session.prepare();
    assert.equal(
      requests.some((x) => x.method === "thread/start"),
      false,
    );
    await gateway.open();
    const responses = [];
    gateway.send = (value) => responses.push(value);
    await gateway.receive(
      Buffer.from(
        JSON.stringify({
          id: 1,
          method: "thread/start",
          params: {
            cwd: "/requested/project",
            sandbox: "read-only",
            approvalPolicy: "never",
            config: { web_search: "disabled" },
            experimentalRawEvents: false,
          },
        }),
      ),
    );
    assert.equal(responses[0].error, undefined);
    assert.equal(session.threadId, "thread-checkpoint");
    const params = requests.find((x) => x.method === "thread/start").params;
    assert.equal(params.cwd, "/requested/project");
    assert.equal(params.sandbox, "read-only");
    assert.equal(params.approvalPolicy, "never");
    assert.equal(params.config.web_search, "disabled");
    assert.equal(params.experimentalRawEvents, true);
    assert.ok(params.config["hooks.state"]);
  } finally {
    await gateway.close();
    await session.close();
  }
});
