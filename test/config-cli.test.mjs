import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { defaults } from "../src/project-config.mjs";

const cli = fileURLToPath(
  new URL("../bin/astra-jev-control.mjs", import.meta.url),
);
const run = (cwd, args = []) =>
  spawnSync(process.execPath, [cli, "config", ...args, "--cwd", cwd], {
    encoding: "utf8",
    timeout: 5000,
  });

test("configuration CLI creates defaults and changes only requested settings without provider setup", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "astra-config-cli-"));
  const path = join(cwd, "astra-jev.json");
  try {
    await assert.rejects(readFile(path), { code: "ENOENT" });
    const initial = run(cwd);
    assert.equal(initial.status, 0, initial.stderr);
    assert.deepEqual(JSON.parse(initial.stdout), {
      path,
      settings: defaults,
      restartRequired: false,
    });
    const legacy = {
      ...defaults,
      noAltScreen: true,
      resumePermissions: "workspace-write",
    };
    await writeFile(path, JSON.stringify(legacy));
    const quiet = run(cwd, ["set", "verbose", "false"]);
    assert.equal(quiet.status, 0, quiet.stderr);
    assert.deepEqual(JSON.parse(quiet.stdout), {
      path,
      settings: { ...defaults, verbose: false },
      restartRequired: true,
    });
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
      ...legacy,
      verbose: false,
    });
    for (const value of [
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
      "null",
    ]) {
      const result = run(cwd, ["set", "fixedEffort", value]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(
        JSON.parse(result.stdout).settings.fixedEffort,
        value === "null" ? null : value,
      );
      assert.equal(JSON.parse(result.stdout).settings.verbose, false);
    }
    assert.equal(run(cwd, ["set", "requireJev", "true"]).status, 0);
    const before = await readFile(path, "utf8");
    for (const args of [
      ["set", "enabled", "false"],
      ["set", "fixedEffort", "high"],
      ["set", "verbose", "null"],
      ["set", "verbose", "1"],
      ["set", "version", "2"],
      ["set", "unknown", "true"],
      ["set", "resumePermissions", "read-only"],
      ["set", "verbose"],
      ["--read-only"],
    ]) {
      const result = run(cwd, args);
      assert.equal(result.status, 1, JSON.stringify(args));
      assert.equal(await readFile(path, "utf8"), before);
    }
    assert.deepEqual(await readdir(cwd), ["astra-jev.json"]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("configuration CLI preserves malformed existing files", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "astra-config-invalid-"));
  const path = join(cwd, "astra-jev.json");
  try {
    for (const content of ["{bad", "null", "[]", '{"unknown":true}']) {
      await writeFile(path, content);
      assert.equal(run(cwd, ["set", "verbose", "false"]).status, 1);
      assert.equal(await readFile(path, "utf8"), content);
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
