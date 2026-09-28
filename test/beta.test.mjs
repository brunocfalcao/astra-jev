import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  mkdtemp,
  rm,
  readFile,
  writeFile,
  stat,
  symlink,
  chmod,
  access,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Controller } from "../src/controller.mjs";
import { Context } from "../src/context.mjs";
import { Session } from "../src/session.mjs";
import { modeLabel } from "../src/status.mjs";
import { acknowledgePrivacy, privacyAcknowledged } from "../src/onboarding.mjs";
import { projectConfig } from "../src/project-config.mjs";

function transportFixture({ sandbox = "readOnly", version = "0.157.1" } = {}) {
  const t = new EventEmitter();
  t.config = [];
  t.calls = [];
  t.connect = async () => ({ userAgent: `astra_jev/${version} fixture` });
  t.close = async () => {};
  t.request = async (method, params) => {
    t.calls.push({ method, params });
    if (method === "model/list")
      return {
        data: [
          {
            model: "gpt-6-astra",
            defaultReasoningEffort: "high",
            supportedReasoningEfforts: [
              { reasoningEffort: "low" },
              { reasoningEffort: "high" },
            ],
          },
        ],
      };
    if (method === "thread/resume")
      return {
        model: "gpt-6-astra",
        sandbox: { type: sandbox },
        thread: { id: "owned", turns: [] },
      };
    if (method === "turn/start") return { turn: { id: "turn" } };
    return {};
  };
  return t;
}

test("resumed policy is read-only before first work and cannot be widened by later client turns", async () => {
  const transport = transportFixture();
  const s = new Session({
    transport,
    jev: { decide: async () => ({ effort: "low", leaseSteps: 1 }) },
  });
  assert.equal(s.threadId, undefined);
  try {
    await s.open({
      resume: "owned",
      params: { sandbox: "danger-full-access", approvalPolicy: "on-request" },
    });
    const open = transport.calls.find(
      (x) => x.method === "thread/resume",
    ).params;
    assert.equal(open.sandbox, "read-only");
    assert.equal(open.approvalPolicy, "never");
    for (let i = 0; i < 2; i++) {
      await s.startTurn({
        threadId: "owned",
        input: [],
        sandboxPolicy: { type: "dangerFullAccess" },
        permissions: { id: "full" },
        approvalPolicy: "on-request",
      });
      const turn = transport.calls
        .filter((x) => x.method === "turn/start")
        .at(-1).params;
      assert.deepEqual(turn.sandboxPolicy, {
        type: "readOnly",
        networkAccess: false,
      });
      assert.equal(turn.approvalPolicy, "never");
      assert.equal(turn.permissions, undefined);
      s.running = false;
    }
  } finally {
    await s.close();
  }
});

test("resume rejects an unconfirmed permission policy before any turn; explicit codex policy delegates", async () => {
  for (const policy of ["read-only", "codex"]) {
    const transport = transportFixture({ sandbox: "dangerFullAccess" });
    const s = new Session({
      transport,
      resumePermissions: policy,
      fixedEffort: "high",
    });
    try {
      if (policy === "read-only")
        await assert.rejects(s.open({ resume: "owned" }), /did not confirm/);
      else {
        await s.open({ resume: "owned" });
        assert.equal(s.status().sandbox, "dangerFullAccess");
      }
      assert.equal(
        transport.calls.some((x) => x.method === "turn/start"),
        false,
      );
    } finally {
      await s.close();
    }
  }
});

test("all managed modes reject an unverified Codex version before thread creation", async () => {
  for (const resume of [undefined, "owned"]) {
    const transport = transportFixture({ version: "0.158.0" });
    const s = new Session({ transport, fixedEffort: "high" });
    try {
      await assert.rejects(s.open({ resume }), /require verified stock Codex/);
      assert.deepEqual(transport.calls, []);
    } finally {
      await s.close();
    }
  }
});

test("required Jev refuses a first-turn failure and interrupts a failed later evaluation", async () => {
  const make = () =>
    new Controller({
      requireJev: true,
      context: new Context(),
      supportedEfforts: ["low", "high"],
      jev: {
        decide: async () => {
          throw Error("provider unavailable");
        },
      },
      rpc: async () => ({ status: "applied" }),
    });
  const c = make();
  await assert.rejects(
    c.begin({ threadId: "owned", prompt: "fixture", defaultEffort: "high" }),
    /required but unavailable/,
  );
  assert.equal(c.active, false);
  const later = make();
  let interruptions = 0;
  later.jev = { decide: async () => ({ effort: "low", leaseSteps: 1 }) };
  await later.begin({
    threadId: "owned",
    prompt: "fixture",
    defaultEffort: "high",
  });
  later.attach("turn");
  later.completedGenerations = 1;
  later.jev = {
    decide: async () => {
      throw Error("provider unavailable");
    },
  };
  later.onFatal = async () => {
    interruptions++;
  };
  assert.equal(later.active, true);
  await later.evaluate();
  assert.equal(later.active, false);
  assert.equal(interruptions, 1);
});

test("privacy acknowledgment is private, versioned and never inferred from project data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "astra-privacy-"));
  try {
    assert.equal(await privacyAcknowledged({ env: {}, directory }), false);
    await acknowledgePrivacy(directory);
    assert.equal(
      (await stat(join(directory, "privacy-v1.json"))).mode & 0o777,
      0o600,
    );
    assert.equal(await privacyAcknowledged({ env: {}, directory }), true);
    await writeFile(
      join(directory, "privacy-v1.json"),
      '{"version":2,"acknowledged":true}',
    );
    assert.equal(await privacyAcknowledged({ env: {}, directory }), false);
    assert.equal(
      await privacyAcknowledged({
        env: { ASTRA_JEV_PRIVACY_ACK: "1" },
        directory,
      }),
      true,
    );
    await acknowledgePrivacy(directory);
    assert.equal(await privacyAcknowledged({ env: {}, directory }), true);
    await rm(join(directory, "privacy-v1.json"));
    await writeFile(join(directory, "unrelated"), "unchanged");
    await symlink(
      join(directory, "unrelated"),
      join(directory, "privacy-v1.json"),
    );
    await assert.rejects(acknowledgePrivacy(directory), /private file/);
    assert.equal(
      await readFile(join(directory, "unrelated"), "utf8"),
      "unchanged",
    );
    await writeFile(
      join(directory, "astra-jev.json"),
      '{"requireJev":true,"enabled":false}',
    );
    await assert.rejects(projectConfig(directory), /requireJev requires/);
    assert.equal(
      await readFile(join(directory, "astra-jev.json"), "utf8"),
      '{"requireJev":true,"enabled":false}',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("required Jev interrupts rejected or uncertain publication exactly once", async () => {
  for (const gated of [false, true]) {
    for (const failure of ["unavailable", "timeout"]) {
      let interruptions = 0;
      const c = new Controller({
        requireJev: true,
        gated,
        context: new Context(),
        supportedEfforts: ["low", "high"],
        jev: { decide: async () => ({ effort: "high", leaseSteps: 1 }) },
        rpc: async () => {
          if (failure === "timeout") throw Error("timeout");
          return { status: "unavailable" };
        },
        onFatal: async () => {
          interruptions++;
        },
      });
      await c.begin({
        threadId: "owned",
        prompt: "fixture",
        defaultEffort: "low",
      });
      c.attach("turn");
      c.capturedEffort = "low";
      c.completedGenerations = 1;
      await c.evaluate();
      assert.equal(c.active, false);
      assert.equal(c.pending, null);
      assert.equal(interruptions, 1);
    }
  }
});

test("required Jev blocks stock fallback before a Codex process starts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "astra-strict-cli-"));
  try {
    await writeFile(join(directory, "astra-jev.json"), '{"requireJev":true}');
    await writeFile(
      join(directory, "codex"),
      '#!/usr/bin/env node\nimport("node:fs").then(fs => fs.writeFileSync("started", "yes"));\n',
    );
    await chmod(join(directory, "codex"), 0o700);
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("../bin/astra-jev.mjs", import.meta.url)),
        "exec",
        "fixture",
      ],
      {
        cwd: directory,
        encoding: "utf8",
        timeout: 5000,
        env: { ...process.env, PATH: `${directory}:${process.env.PATH}` },
      },
    );
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /Jev is required.*No Codex process was started/,
    );
    await assert.rejects(access(join(directory, "started")), {
      code: "ENOENT",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("mode labels distinguish adaptive, resumed, fixed and inactive without claiming health", () => {
  assert.match(
    modeLabel({
      mode: "adaptive-checkpoint",
      policy: "auto",
      sandbox: "readOnly",
    }),
    /ADAPTIVE.*readOnly/,
  );
  assert.match(
    modeLabel({ mode: "turn-only-resume", policy: "auto" }),
    /PER-TURN \(capture unavailable\)/,
  );
  assert.match(
    modeLabel({ mode: "turn-only-resume", policy: "high" }),
    /FIXED/,
  );
  assert.match(modeLabel({ mode: "unknown", policy: "auto" }), /INACTIVE/);
});
