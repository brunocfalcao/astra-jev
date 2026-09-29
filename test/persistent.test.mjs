import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm, access } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { AppServer } from "../src/app-server.mjs";
import { Session } from "../src/session.mjs";
import {
  SessionHost,
  SessionClient,
  sessionSocket,
  enableSession,
} from "../src/persistent.mjs";

test("enable discovers only the current thread and refuses missing or duplicate hosts", async () => {
  const directory = await mkdtemp("/tmp/astra-jev-enable-test-");
  const hosts = [];
  let enabled = 0;
  const create = async (name, threadId) => {
    const session = {
      threadId,
      transport: new (await import("node:events")).EventEmitter(),
      status() {
        return { threadId: this.threadId, jevPaused: true };
      },
      enableJev() {
        enabled++;
        return { ...this.status(), jevPaused: false };
      },
      async close() {},
    };
    const host = new SessionHost({
      session,
      info: {},
      path: await sessionSocket(name, directory),
      observerOnly: true,
    });
    hosts.push(host);
    await host.listen();
    return session;
  };
  try {
    await assert.rejects(
      () => enableSession(undefined, directory),
      /CODEX_THREAD_ID/,
    );
    await create("other", "other-thread");
    await assert.rejects(
      () => enableSession("target-thread", directory),
      /one live/,
    );
    assert.equal(enabled, 0);
    const target = await create("target", "target-thread");
    const result = await enableSession("target-thread", directory);
    assert.equal(result.threadId, "target-thread");
    assert.equal(result.jevPaused, false);
    assert.equal(enabled, 1);
    await create("duplicate", target.threadId);
    await assert.rejects(
      () => enableSession("target-thread", directory),
      /duplicate hosts/,
    );
    assert.equal(enabled, 1);
  } finally {
    for (const host of hosts) await host.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("detach and reconnect retain one native session, raw capture events and approvals", async () => {
  const directory = await mkdtemp("/tmp/astra-jev-persist-test-");
  const path = await sessionSocket("fixture", directory),
    records = [];
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
  let choices = 0;
  const session = new Session({
    transport,
    jev: {
      decide: async () => ({
        effort: ++choices % 2 ? "low" : "high",
        leaseSteps: 1,
      }),
    },
    record: (x) => records.push(x),
  });
  let host, first, second, intruder;
  try {
    const info = await session.open();
    host = new SessionHost({ session, info, path });
    await host.listen();
    first = new SessionClient({ path });
    assert.equal((await first.open()).threadId, info.threadId);
    assert.equal((await first.run("First fixture")).text, "CHECKPOINT_OK");
    await first.close();
    await delay(5);
    const answers = [];
    second = new SessionClient({
      path,
      onRequest: (m) => {
        answers.push(m.method);
        return { decision: "accept" };
      },
    });
    assert.equal((await second.open()).threadId, info.threadId);
    intruder = new SessionClient({ path });
    await assert.rejects(() => intruder.open(), /already has/);
    const status = await intruder.status();
    assert.equal(status.live, true);
    assert.equal(status.capturedEffort, "high");
    assert.equal(status.threadId, info.threadId);
    await assert.rejects(() => intruder.setEffort("low"), /Attach before/);
    assert.deepEqual(
      await session.onRequest({
        method: "item/commandExecution/requestApproval",
        params: { command: "synthetic" },
      }),
      { decision: "accept" },
    );
    assert.deepEqual(answers, ["item/commandExecution/requestApproval"]);
    assert.equal((await second.run("Second fixture")).text, "CHECKPOINT_OK");
    assert.deepEqual(
      records
        .filter((x) => x.type === "generation_completed")
        .map((x) => x.effort),
      ["low", "high", "low", "high"],
    );
    assert.equal(records.filter((x) => x.type === "session_opened").length, 1);
    const manual = await second.setEffort("high");
    assert.equal(manual.policy, "manual");
    assert.equal(manual.manualEffort, "high");
    assert.equal(manual.jevPaused, true);
    const count = choices;
    await second.run("Manual fixture");
    assert.equal(choices, count);
    assert.equal((await intruder.status()).capturedEffort, "high");
    await second.setEffort("auto");
    await second.run("Adaptive again");
    assert.ok(choices > count);
    await second.request("stop");
    await host.done;
    assert.equal(transport.closed, true);
    await assert.rejects(() => access(path), /ENOENT/);
  } finally {
    await first?.close();
    await second?.close();
    await intruder?.close();
    if (host) await host.close();
    else await session.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("disconnect declines a pending approval and interrupts active work", async () => {
  const directory = await mkdtemp("/tmp/astra-jev-disconnect-test-");
  const path = await sessionSocket("fixture", directory);
  const transport = new (await import("node:events")).EventEmitter();
  let interrupts = 0;
  const session = {
    transport,
    running: true,
    onNotice() {},
    interrupt: async () => {
      interrupts++;
      session.running = false;
    },
    close: async () => {},
  };
  const host = new SessionHost({ session, info: { threadId: "t" }, path });
  const client = new SessionClient({
    path,
    onRequest: () => new Promise(() => {}),
  });
  try {
    await host.listen();
    await client.open();
    const approval = session.onRequest({
      method: "item/commandExecution/requestApproval",
    });
    await client.close();
    assert.equal(await approval, undefined);
    assert.equal(interrupts, 1);
    assert.equal(host.requests.size, 0);
  } finally {
    await client.close();
    await host.close();
    await rm(directory, { recursive: true, force: true });
  }
});
