import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  writeFile,
  chmod,
  access,
  rm,
  readFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
const root = fileURLToPath(new URL("..", import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), "astra-install-"));
const prefix = join(scratch, "prefix");
const fixture = join(scratch, "fixture");
const workspace = join(scratch, "project");
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: scratch,
    encoding: "utf8",
    timeout: 60000,
    ...options,
  });
  assert.equal(result.status, 0, `${command} failed: ${result.stderr}`);
  return result;
};
try {
  await mkdir(fixture);
  await mkdir(workspace);
  await writeFile(
    join(fixture, "codex"),
    '#!/usr/bin/env node\nconsole.log("codex-cli fixture");\n',
  );
  await chmod(join(fixture, "codex"), 0o700);
  const packed = JSON.parse(
    run(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", scratch],
      { cwd: root },
    ).stdout,
  )[0];
  const archive = join(scratch, packed.filename);
  const installArgs = [
    "install",
    "--global",
    "--prefix",
    prefix,
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    archive,
  ];
  run("npm", installArgs);
  const env = { ...process.env, PATH: `${fixture}:${process.env.PATH}` };
  delete env.TYPESAFE_API_KEY;
  const executable = join(prefix, "bin/astra-jev");
  assert.match(
    run(executable, ["--version"], { cwd: workspace, env }).stdout,
    /codex-cli fixture/,
  );
  assert.equal(
    JSON.parse(await readFile(join(workspace, "astra-jev.json"), "utf8"))
      .resumePermissions,
    "read-only",
  );
  assert.match(
    run(join(prefix, "bin/astra-jev-control"), ["--help"], {
      cwd: workspace,
      env,
    }).stdout,
    /astra-jev-control/,
  );
  const settingsPath = join(workspace, "astra-jev.json");
  const settings = JSON.parse(await readFile(settingsPath, "utf8"));
  const customized =
    JSON.stringify({
      ...settings,
      verbose: false,
      resumePermissions: "workspace-write",
    }) + "\n";
  await writeFile(settingsPath, customized);
  run("npm", installArgs); // Reinstallation/upgrade mechanics, same version.
  assert.match(
    run(executable, ["--version"], { cwd: workspace, env }).stdout,
    /codex-cli fixture/,
  );
  assert.equal(await readFile(settingsPath, "utf8"), customized);
  run("npm", [
    "uninstall",
    "--global",
    "--prefix",
    prefix,
    "--ignore-scripts",
    "astra-jev",
  ]);
  await assert.rejects(access(executable), { code: "ENOENT" });
  await assert.rejects(access(join(prefix, "bin/astra-jev-control")), {
    code: "ENOENT",
  });
  assert.equal(await readFile(settingsPath, "utf8"), customized);
  console.log(
    "Isolated-prefix install, reinstall, both commands and uninstall passed; project settings preserved.",
  );
} finally {
  await rm(scratch, { recursive: true, force: true });
}
