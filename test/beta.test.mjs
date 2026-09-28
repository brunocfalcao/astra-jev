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
import { callBridge } from "../src/hook-bridge.mjs";
import { modeLabel } from "../src/status.mjs";
import { acknowledgePrivacy, privacyAcknowledged } from "../src/onboarding.mjs";
import { projectConfig } from "../src/project-config.mjs";

function transportFixture({
  sandbox = "readOnly",
  version = "0.157.1",
  resumeResult = {},
} = {}) {
  const hook = {
    handlerType: "mcpTool",
    server: "astra_jev_checkpoint",
    tool: "checkpoint",
    eventName: "postToolUse",
    source: "sessionFlags",
    sourcePath: "/<session-flags>/config.toml",
    displayOrder: 0,
    key: "/<session-flags>/config.toml:post_tool_use:0:0",
    matcher: ".*",
    currentHash: "fixture-hash",
    timeoutSec: 20,
    enabled: true,
  };
  const t = new EventEmitter();
  t.config = [];
  t.calls = [];
  t.connect = async () =>
    version === null ? {} : { userAgent: `astra_jev/${version} fixture` };
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
    if (method === "hooks/list") return { data: [{ hooks: [hook] }] };
    if (["thread/start", "thread/resume"].includes(method)) {
      const args = t.config.find((x) =>
        x.startsWith("mcp_servers.astra_jev_checkpoint.args="),
      );
      if (args)
        await callBridge(JSON.parse(args.slice(args.indexOf("=") + 1))[1], {
          op: "ready",
        });
      return {
        model: "gpt-6-astra",
        sandbox: { type: sandbox },
        thread: { id: "owned", turns: [] },
        ...resumeResult,
      };
    }
    if (method === "turn/start") return { turn: { id: "turn" } };
    return {};
  };
  return t;
}

test("resumed sessions leave native permissions unchanged across Astra and Sol turns and settings", async () => {
  for (const sandbox of [
    { type: "readOnly", networkAccess: false },
    {
      type: "workspaceWrite",
      writableRoots: ["/project"],
      networkAccess: true,
    },
    { type: "dangerFullAccess" },
  ]) {
    const transport = transportFixture({ resumeResult: { sandbox } });
    let decisions = 0;
    const s = new Session({
      transport,
      jev: {
        decide: async () => {
          decisions++;
          return { effort: "low", leaseSteps: 1 };
        },
      },
    });
    try {
      assert.equal(s.threadId, undefined);
      await s.open({
        resume: "owned",
        params: {
          cwd: "/project",
          approvalPolicy: "on-request",
          config: { "sandbox_workspace_write.network_access": true },
        },
      });
      assert.deepEqual(
        transport.calls.find((r) => r.method === "thread/resume").params,
        {
          threadId: "owned",
          cwd: "/project",
          model: "gpt-6-astra",
          approvalPolicy: "on-request",
          config: {
            "sandbox_workspace_write.network_access": true,
            ...s.hookConfig,
          },
        },
      );
      assert.equal(s.status().sandbox, sandbox.type);
      for (const model of ["gpt-6-astra", "gpt-6-sol", "gpt-6-astra"]) {
        const permissions = {
          sandboxPolicy: sandbox,
          approvalPolicy: "on-request",
          cwd: "/native-project",
          runtimeWorkspaceRoots: ["/native-project"],
        };
        await s.startTurn({ model, input: [], ...permissions });
        const sent = transport.calls
          .filter((r) => r.method === "turn/start")
          .at(-1).params;
        for (const [key, value] of Object.entries(permissions))
          assert.deepEqual(sent[key], value);
        s.running = false;
        const settings = {
          model,
          threadId: "owned",
          permissions: "native-profile",
          approvalPolicy: "untrusted",
          cwd: "/native-project",
        };
        await s.updateSettings(settings);
        assert.deepEqual(transport.calls.at(-1), {
          method: "thread/settings/update",
          params: settings,
        });
      }
      assert.equal(decisions, 2);
    } finally {
      await s.close();
    }
  }
});

test("resume without permission overrides adds no wrapper sandbox or approval policy", async () => {
  const transport = transportFixture();
  const s = new Session({ transport, fixedEffort: "high" });
  try {
    await s.open({ resume: "owned" });
    assert.deepEqual(
      transport.calls.find((r) => r.method === "thread/resume").params,
      { threadId: "owned", model: "gpt-6-astra", config: {} },
    );
    await s.startTurn({ input: [] });
    const turn = transport.calls.at(-1).params;
    for (const key of [
      "sandboxPolicy",
      "approvalPolicy",
      "permissions",
      "runtimeWorkspaceRoots",
      "cwd",
    ])
      assert.equal(Object.hasOwn(turn, key), false);
  } finally {
    await s.close();
  }
});

test("fresh and resumed managed sessions open without Codex version validation", async () => {
  for (const version of ["0.157.1", "0.158.0", "99.0.0", null]) {
    for (const resume of [undefined, "owned"]) {
      for (const fixedEffort of [null, "high"]) {
        const transport = transportFixture({ version });
        const s = new Session({
          transport,
          fixedEffort,
          jev: { decide: async () => ({ effort: "low", leaseSteps: 1 }) },
        });
        try {
          assert.deepEqual(transport.calls, []);
          const opened = await s.open({ resume });
          assert.equal(opened.threadId, "owned");
          assert.equal(
            opened.mode,
            fixedEffort
              ? "fixed"
              : resume
                ? "adaptive-resume"
                : "adaptive-checkpoint",
          );
          assert.deepEqual(
            transport.calls
              .filter((call) => call.method.startsWith("thread/"))
              .map((call) => call.method),
            [resume ? "thread/resume" : "thread/start"],
          );
        } finally {
          await s.close();
        }
      }
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
  assert.equal(
    modeLabel({ mode: "turn-only-resume", policy: "auto" }),
    "Jev mode: PER-TURN | Permissions: not selected | Require Jev: off",
  );
  assert.match(
    modeLabel({ mode: "turn-only-resume", policy: "high" }),
    /FIXED/,
  );
  assert.match(modeLabel({ mode: "unknown", policy: "auto" }), /INACTIVE/);
});
