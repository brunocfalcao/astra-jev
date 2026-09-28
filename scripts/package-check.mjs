import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
const root = new URL("../", import.meta.url);
const run = spawnSync(
  "npm",
  ["pack", "--dry-run", "--ignore-scripts", "--json"],
  { cwd: fileURLToPath(root), encoding: "utf8" },
);
assert.equal(run.status, 0, run.stderr);
const packed = JSON.parse(run.stdout)[0];
const expected = new Set([
  "package.json",
  "README.md",
  "CONTRIBUTING.md",
  "assets/icon.svg",
  "assets/logo.svg",
  "assets/banner.svg",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "PRIVACY.md",
  "SECURITY.md",
  "CHANGELOG.md",
  "docs/ARCHITECTURE.md",
  "docs/COMPATIBILITY.md",
  "docs/RELEASING.md",
  "docs/DEMO.md",
  "examples/astra-jev.json",
  "skills/astra-jev/SKILL.md",
  ...["astra-jev.mjs", "astra-jev-control.mjs", "hook-mcp.mjs"].map(
    (x) => `bin/${x}`,
  ),
  ...(await readdir(new URL("src/", root)))
    .filter((x) => x.endsWith(".mjs"))
    .map((x) => `src/${x}`),
]);
assert.deepEqual(
  new Set(packed.files.map((x) => x.path)),
  expected,
  "Package file allowlist changed",
);
for (const { path } of packed.files) {
  const text = await readFile(new URL(path, root), "utf8");
  assert.ok(
    !/\/Users\/falcaob|\/var\/folders\/|BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|TYPESAFE_API_KEY\s*=\s*[A-Za-z0-9_-]{16,}/.test(
      text,
    ),
    `Private content pattern in ${path}`,
  );
}
console.log(
  `Package allowlist passed: ${packed.files.length} files, ${packed.unpackedSize} unpacked bytes.`,
);
