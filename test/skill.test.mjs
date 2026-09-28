import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  symlink,
  rm,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSkill } from "../src/skill.mjs";

test("bundled skill installs once, upgrades owned content and preserves user edits", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "astra-skill-"));
  const directory = join(scratch, "skills/astra-jev");
  const path = join(directory, "SKILL.md");
  const source = join(scratch, "fixture.md");
  try {
    await assert.rejects(readFile(path), { code: "ENOENT" });
    assert.equal((await installSkill({ directory })).status, "installed");
    const bundled = await readFile(
      new URL("../skills/astra-jev/SKILL.md", import.meta.url),
      "utf8",
    );
    assert.equal(await readFile(path, "utf8"), bundled);
    assert.equal((await installSkill({ directory })).status, "current");
    await writeFile(source, bundled + "\nA new instruction.\n");
    assert.equal((await installSkill({ directory, source })).status, "updated");
    assert.equal(await readFile(path, "utf8"), await readFile(source, "utf8"));
    const custom = bundled + "\nMy personal instruction.\n";
    await writeFile(path, custom);
    assert.equal((await installSkill({ directory })).status, "preserved");
    assert.equal(await readFile(path, "utf8"), custom);
    assert.deepEqual((await readdir(directory)).sort(), [
      ".astra-jev-managed.json",
      "SKILL.md",
    ]);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("skill installer never replaces an unrelated skill or writes through skill and marker links", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "astra-skill-preserve-"));
  const target = join(scratch, "unrelated.md");
  const content = "User-owned content\n";
  try {
    await writeFile(target, content);
    for (const kind of [
      "unowned",
      "skill-link",
      "marker-link",
      "directory-link",
      "bad-marker",
    ]) {
      const directory = join(scratch, kind);
      if (kind === "directory-link") {
        const actual = join(scratch, "actual");
        await mkdir(actual);
        await symlink(actual, directory);
      } else {
        await mkdir(directory);
        if (kind === "unowned")
          await writeFile(join(directory, "SKILL.md"), content);
        if (kind === "skill-link")
          await symlink(target, join(directory, "SKILL.md"));
        if (kind === "marker-link")
          await symlink(target, join(directory, ".astra-jev-managed.json"));
        if (kind === "bad-marker")
          await writeFile(
            join(directory, ".astra-jev-managed.json"),
            "invalid",
          );
      }
      assert.equal(
        (await installSkill({ directory })).status,
        "preserved",
        kind,
      );
      assert.equal(await readFile(target, "utf8"), content);
      if (kind === "unowned")
        assert.equal(
          await readFile(join(directory, "SKILL.md"), "utf8"),
          content,
        );
      if (["marker-link", "directory-link", "bad-marker"].includes(kind))
        await assert.rejects(readFile(join(directory, "SKILL.md")), {
          code: "ENOENT",
        });
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
