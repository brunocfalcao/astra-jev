import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { once, EventEmitter } from "node:events";
import {
  stat,
  mkdtemp,
  rm,
  readFile,
  writeFile,
  chmod,
} from "node:fs/promises";
import { join } from "node:path";
import { NativeTui } from "../src/native-tui.mjs";
import WebSocket from "ws";
import { Session } from "../src/session.mjs";
import { AppServer } from "../src/app-server.mjs";
import { SessionHost, SessionClient } from "../src/persistent.mjs";

test("managed TUI leaves native display defaults alone and forwards explicit display flags", async () => {
  const cwd = await mkdtemp("/tmp/astra-native-display-");
  const previousPath = process.env.PATH;
  const capture = join(cwd, "args.json");
  const executable = join(cwd, "codex");
  await writeFile(
    executable,
    `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2)));\n`,
  );
  await chmod(executable, 0o700);
  process.env.PATH = `${cwd}:${previousPath}`;
  try {
    const gateway = new NativeTui({ session: {} });
    gateway.path = "/owner/native.sock";
    for (const args of [
      ["resume", "owned"],
      ["--no-alt-screen", "resume", "owned"],
    ]) {
      assert.equal((await gateway.launch({ codexArgs: args })).code, 0);
      assert.deepEqual(JSON.parse(await readFile(capture, "utf8")), [
        "--remote",
        "unix:///owner/native.sock",
        "--model",
        "gpt-6-astra",
        ...args,
      ]);
    }
  } finally {
    process.env.PATH = previousPath;
    await rm(cwd, { recursive: true, force: true });
  }
});

test("resume picker hands off overlapping connections without misrouting replies or losing ownership", async () => {
  const transport = new EventEmitter();
  let finishListing, listingStarted;
  const listing = new Promise((resolve) => {
    listingStarted = resolve;
  });
  transport.request = async (method) => {
    assert.equal(method, "thread/list");
    listingStarted();
    return new Promise((resolve) => {
      finishListing = resolve;
    });
  };
  const session = {
    transport,
    resumed: true,
    initialized: { userAgent: "astra_jev/0.157.1 fixture" },
    controller: { context: { clean: (text) => text } },
  };
  const gateway = new NativeTui({ session });
  const clients = [];
  const connect = () => {
    const client = new WebSocket(`ws+unix://${gateway.path}:/rpc`);
    clients.push(client);
    return client;
  };
  try {
    await gateway.open();
    const picker = connect();
    await once(picker, "open");
    picker.send(JSON.stringify({ id: 1, method: "thread/list", params: {} }));
    await listing;
    const pickerClosed = once(picker, "close");
    const tui = connect();
    await once(tui, "open");
    const messages = [];
    tui.on("message", (data) => messages.push(JSON.parse(data)));
    await pickerClosed;
    assert.equal(gateway.client.readyState, WebSocket.OPEN);
    finishListing({ data: [{ id: "picker-only-result" }] });
    const initialized = once(tui, "message");
    tui.send(JSON.stringify({ id: 1, method: "initialize", params: {} }));
    assert.deepEqual(JSON.parse((await initialized)[0]), {
      id: 1,
      result: session.initialized,
    });
    const pong = once(tui, "pong");
    tui.ping();
    await pong;
    assert.deepEqual(messages, [{ id: 1, result: session.initialized }]);

    // Only a resume picker before selection may hand off its connection.
    for (const state of ["fresh", "opening", "owned"]) {
      session.resumed = state !== "fresh";
      gateway.opening = state === "opening";
      if (state === "owned") session.threadId = "owned-thread";
      const extra = connect();
      await assert.rejects(once(extra, "open"), /socket hang up/);
      assert.equal(tui.readyState, WebSocket.OPEN);
    }
  } finally {
    finishListing?.({ data: [] });
    for (const client of clients) client.terminate();
    await gateway.close();
  }
});

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
      () => rpc("turn/steer", { threadId: "foreign", input: [] }),
      /different owned/,
    );
    await rpc("turn/start", {
      threadId: session.threadId,
      input: [{ type: "text", text: "Read synthetic fixture" }],
      sandboxPolicy: { type: "dangerFullAccess" },
      permissions: { fixture: "override" },
    });
    await complete;
    assert.deepEqual(turnParams[0].sandboxPolicy, { type: "dangerFullAccess" });
    assert.deepEqual(turnParams[0].permissions, { fixture: "override" });
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
      [],
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
      assert.equal(records[displayed].displayed, false);
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
  transport.request = async (method, params, options) => {
    requests.push({ method, params });
    if (method === "thread/read") return { thread: { id: params.threadId } };
    return request(method, params, options);
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
    assert.equal(selected.result.thread.id, "thread-checkpoint");
    assert.equal(session.threadId, "thread-checkpoint");
    assert.equal(opened.mode, "adaptive-resume");
    assert.equal(session.controller.captureEvents, false);
    assert.deepEqual(
      requests.find((x) => x.method === "thread/resume").params,
      {
        threadId: "selected",
        cwd: "/project",
        model: "gpt-6-astra",
        config: { web_search: "disabled", ...session.hookConfig },
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

test("reattaching the owned resumed thread preserves the native current permissions", async () => {
  const calls = [];
  const scope = {
    "sandbox_workspace_write.writable_roots": [],
    "sandbox_workspace_write.network_access": false,
  };
  const session = {
    threadId: "owned",
    selectedModel: "gpt-6-sol",
    threadOptions: {
      cwd: "/project",
      sandbox: "workspace-write",
      approvalPolicy: "never",
      permissions: null,
      runtimeWorkspaceRoots: ["/project"],
      config: scope,
    },
    transport: {
      request: async (method, params) => {
        calls.push({ method, params });
        return {};
      },
    },
    controller: { context: { clean: (text) => text } },
  };
  const gateway = new NativeTui({ session });
  gateway.send = (response) => assert.equal(response.error, undefined);
  await gateway.receive(
    Buffer.from(
      JSON.stringify({
        id: 1,
        method: "thread/resume",
        params: {
          threadId: "owned",
          cwd: "/elsewhere",
          sandbox: "danger-full-access",
          permissions: "full",
          runtimeWorkspaceRoots: ["/elsewhere"],
          config: {
            web_search: "disabled",
            "sandbox_workspace_write.network_access": true,
            "sandbox_workspace_write.writable_roots": ["/elsewhere"],
          },
        },
      }),
    ),
  );
  assert.deepEqual(calls, [
    {
      method: "thread/resume",
      params: {
        threadId: "owned",
        model: "gpt-6-sol",
        cwd: "/elsewhere",
        sandbox: "danger-full-access",
        permissions: "full",
        runtimeWorkspaceRoots: ["/elsewhere"],
        config: {
          web_search: "disabled",
          "sandbox_workspace_write.network_access": true,
          "sandbox_workspace_write.writable_roots": ["/elsewhere"],
        },
      },
    },
  ]);
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

test("Esc from the resume picker prepares a fresh adaptive session and retires the picker backend", async () => {
  const sessions = [];
  const starts = [];
  const createFreshSession = () => {
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
    const session = new Session({
      transport,
      jev: { decide: async () => ({ effort: "low", leaseSteps: 1 }) },
    });
    const request = transport.request.bind(transport);
    transport.request = (method, params, options) => {
      if (method === "thread/start") starts.push(params);
      return request(method, params, options);
    };
    sessions.push(session);
    return session;
  };
  const picker = createFreshSession();
  const directory = await mkdtemp("/tmp/astra-picker-host-");
  const host = new SessionHost({
    session: picker,
    info: {},
    path: join(directory, "observer.sock"),
    observerOnly: true,
  });
  const observer = new SessionClient({ path: host.path });
  let current = picker;
  const gateway = new NativeTui({
    session: picker,
    createFreshSession,
    onSessionChanged: (session) => {
      current = session;
      host.replaceSession(session);
    },
  });
  const replies = [];
  try {
    await picker.prepare({ resume: true });
    await host.listen();
    await gateway.open();
    gateway.send = (message) => replies.push(message);
    await gateway.receive(
      Buffer.from(
        JSON.stringify({
          id: 1,
          method: "thread/start",
          params: {
            cwd: "/new-project",
            sandbox: "read-only",
            approvalPolicy: "never",
            config: { web_search: "disabled" },
          },
        }),
      ),
    );
    assert.equal(replies[0].error, undefined);
    assert.notEqual(current, picker);
    assert.equal(gateway.session, current);
    assert.equal(picker.closed, true);
    assert.equal(picker.transport.closed, true);
    assert.equal(picker.transport.listenerCount("closed"), 0);
    assert.equal(gateway.backendFailed, undefined);
    assert.equal(gateway.server.listening, true);
    assert.equal(current.mode, "adaptive-checkpoint");
    assert.equal(current.controller.captureEvents, true);
    assert.equal(current.controller.gated, true);
    assert.equal(starts.length, 1);
    assert.equal(starts[0].sandbox, "read-only");
    assert.equal(starts[0].approvalPolicy, "never");
    assert.equal(starts[0].cwd, "/new-project");
    assert.equal(starts[0].config.web_search, "disabled");
    assert.ok(starts[0].config["hooks.state"]);
    assert.equal(current.bridge.ready, true);
    assert.equal(current.transport.listenerCount("closed"), 2);
    assert.equal(host.server.listening, true);
    await observer.connect();
    assert.equal((await observer.status()).mode, "adaptive-checkpoint");
    assert.equal(replies[0].result.thread.id, current.threadId);
    await gateway.receive(
      Buffer.from(JSON.stringify({ id: 2, method: "thread/start" })),
    );
    assert.match(replies[1].error.message, /owns one thread/);
  } finally {
    observer.close();
    await gateway.close();
    await host.close();
    for (const session of sessions) await session.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed or cancelled fresh preparation closes the candidate and preserves the picker", async () => {
  for (const scenario of ["failure", "shutdown"]) {
    const picker = { transport: new EventEmitter(), resumed: true };
    let release, prepared;
    let closed = 0;
    const preparing = new Promise((resolve) => {
      prepared = resolve;
    });
    const candidate = {
      prepare: async () => {
        prepared();
        if (scenario === "failure") throw new Error("fixture prepare failure");
        await new Promise((resolve) => {
          release = resolve;
        });
      },
      close: async () => {
        closed++;
      },
    };
    const gateway = new NativeTui({
      session: picker,
      createFreshSession: () => candidate,
      onSessionChanged: () =>
        assert.fail("Failed preparation must not replace the session"),
    });
    try {
      await gateway.open();
      const operation = gateway.startFreshSession();
      const rejected = assert.rejects(
        operation,
        /fixture prepare failure|disconnected/,
      );
      await preparing;
      if (scenario === "shutdown") {
        await gateway.close();
        release();
      }
      await rejected;
      assert.equal(closed, 1);
      assert.equal(gateway.session, picker);
      if (scenario === "failure") assert.equal(gateway.server.listening, true);
    } finally {
      await gateway.close();
    }
  }
});
