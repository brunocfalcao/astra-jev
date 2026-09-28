import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const cwd = fileURLToPath(new URL("..", import.meta.url));
for (const directory of ["bin", "src", "test", "scripts"]) {
  for (const file of await readdir(
    new URL(`../${directory}/`, import.meta.url),
  )) {
    if (!file.endsWith(".mjs")) continue;
    const result = spawnSync(
      process.execPath,
      ["--check", `${directory}/${file}`],
      { cwd, stdio: "inherit" },
    );
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
const result = spawnSync(process.execPath, ["--test"], {
  cwd,
  stdio: "inherit",
});
process.exitCode = result.status ?? 1;
