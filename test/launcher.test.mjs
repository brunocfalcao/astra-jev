import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { projectConfig, defaults } from "../src/project-config.mjs";
import {
  planLaunch,
  runCodex,
  exitCode,
  snapshotDefaults,
} from "../src/codex-launch.mjs";

test("project config creates defaults once and preserves existing and invalid files", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "astra-config-"));
  const path = join(cwd, "astra-jev.json");
  try {
    await assert.rejects(readFile(path), { code: "ENOENT" });
    const results = await Promise.all([projectConfig(cwd), projectConfig(cwd)]);
    assert.deepEqual(results, [defaults, defaults]);
    const custom = '{"enabled":false,"fixedEffort":"high"}\n';
    await writeFile(path, custom);
    assert.deepEqual(await projectConfig(cwd), {
      ...defaults,
      enabled: false,
      fixedEffort: "high",
    });
    assert.equal(await readFile(path, "utf8"), custom);
    for (const invalid of [
      "{bad",
      "null",
      "[]",
      '{"enabled":"false"}',
      '{"version":2}',
      '{"fixedEffort":"bogus"}',
      '{"apiKey":"synthetic-secret"}',
    ]) {
      await writeFile(path, invalid);
      await assert.rejects(
        projectConfig(cwd),
        (error) => !error.message.includes("synthetic-secret"),
      );
      assert.equal(await readFile(path, "utf8"), invalid);
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("launch routing preserves prompts, resume syntax and Codex option boundaries", () => {
  for (const args of [
    [],
    ["resume"],
    ["resume", "--last"],
    ["resume", "named session", "prompt"],
    ["--", "resume"],
    ["-i", "resume", "a prompt"],
    ["--model=gpt-6-astra", "--sandbox=read-only", "prompt"],
  ]) {
    const original = [...args];
    const plan = planLaunch(args, "/project");
    assert.equal(plan.direct, false);
    assert.deepEqual(args, original);
  }
  assert.equal(planLaunch(["--", "resume"]).resume, false);
  assert.equal(planLaunch(["--", "--help"]).direct, false);
  assert.equal(planLaunch(["-i", "resume", "prompt"]).resume, false);
  assert.deepEqual(
    planLaunch(["-mgpt-6-astra", "-Cother", "-cweb_search=live"], "/project"),
    {
      cwd: "/project/other",
      command: undefined,
      resume: false,
      config: ["web_search=live"],
      direct: false,
      reason: undefined,
      defaults: [],
    },
  );
  for (const args of [
    ["exec", "a prompt"],
    ["doctor"],
    ["resume", "--help"],
    ["--version"],
    ["--future-option", "resume"],
    ["--model", "gpt-6-sol"],
    ["--remote", "unix:///elsewhere"],
    ["--add-dir", "/other"],
    ["resume", "--last", "-s", "read-only"],
    ["--enable", "shell_snapshot"],
    ["-c", "features={hooks=false}"],
  ]) {
    assert.equal(planLaunch(args).direct, true, JSON.stringify(args));
  }
});

test("direct execution preserves every argument, exit status and credential isolation", async () => {
  const args = [
    "exec",
    "--unknown=literal",
    "spaces and quotes ' \" $() ;",
    "--",
    "-prompt",
  ];
  const original = [...args];
  let seen;
  const child = new EventEmitter();
  child.kill = () => {};
  const previous = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = "test-key-never-forwarded";
  try {
    const result = runCodex(args, {
      spawnImpl: (binary, argv, options) => {
        seen = { binary, argv, options };
        queueMicrotask(() => child.emit("exit", 23, null));
        return child;
      },
    });
    assert.deepEqual(await result, { code: 23, signal: null });
    assert.equal(seen.binary, "codex");
    assert.deepEqual(seen.argv, original);
    assert.equal(seen.options.shell, false);
    assert.equal(seen.options.env.TYPESAFE_API_KEY, undefined);
    assert.equal(exitCode({ code: 23, signal: null }), 23);
    assert.equal(exitCode({ code: null, signal: "SIGTERM" }), 143);
  } finally {
    if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previous;
  }
});

test("installed entry point creates project JSON and forwards native commands without loading Jev", async () => {
  const { spawnSync } = await import("node:child_process");
  const { chmod, mkdir } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const cwd = await mkdtemp(join(tmpdir(), "astra-cli-"));
  const binary = join(cwd, "codex");
  const capture = join(cwd, "capture.json");
  const project = join(cwd, "project with spaces");
  await mkdir(project);
  await writeFile(
    binary,
    `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(process.env.ASTRA_TEST_CAPTURE, JSON.stringify({args: process.argv.slice(2), hasKey: !!process.env.TYPESAFE_API_KEY})); process.exit(23);\n`,
  );
  await chmod(binary, 0o700);
  const entry = fileURLToPath(new URL("../bin/astra-jev.mjs", import.meta.url));
  try {
    for (const args of [
      ["--help"],
      ["doctor"],
      ["resume", "--help"],
      ["exec", "--future-option", "spaces ' quotes ; $()"],
      ["--tui"],
      ["-C", project, "--version"],
    ]) {
      const result = spawnSync(process.execPath, [entry, ...args], {
        cwd,
        encoding: "utf8",
        timeout: 5000,
        env: {
          ...process.env,
          PATH: `${cwd}:${process.env.PATH}`,
          TYPESAFE_API_KEY: "not-a-real-key",
          ASTRA_TEST_CAPTURE: capture,
        },
      });
      assert.equal(
        result.status,
        23,
        JSON.stringify({
          stderr: result.stderr,
          stdout: result.stdout,
          capture: await readFile(capture, "utf8").catch(() => "missing"),
        }),
      );
      assert.deepEqual(JSON.parse(await readFile(capture, "utf8")), {
        args: [...snapshotDefaults, ...args],
        hasKey: false,
      });
      assert.match(result.stderr, /Jev inactive/);
      assert.doesNotMatch(result.stderr, /not-a-real-key/);
    }
    assert.deepEqual(
      JSON.parse(await readFile(join(cwd, "astra-jev.json"), "utf8")),
      defaults,
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(project, "astra-jev.json"), "utf8")),
      defaults,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
