import {
  mkdir,
  lstat,
  readFile,
  writeFile,
  rename,
  rm,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

const digest = (text) => createHash("sha256").update(text).digest("hex");

export async function installSkill({
  directory = join(
    process.env.CODEX_HOME || join(homedir(), ".codex"),
    "skills",
    "astra-jev",
  ),
  source = new URL("../skills/astra-jev/SKILL.md", import.meta.url),
} = {}) {
  const content = await readFile(source, "utf8");
  await mkdir(directory, { recursive: true });
  const path = join(directory, "SKILL.md");
  const marker = join(directory, ".astra-jev-managed.json");
  if (!(await lstat(directory)).isDirectory())
    return { status: "preserved", path };
  let existing;
  try {
    if (!(await lstat(path)).isFile()) return { status: "preserved", path };
    existing = await readFile(path, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  let owned;
  try {
    if (!(await lstat(marker)).isFile()) return { status: "preserved", path };
    owned = JSON.parse(await readFile(marker, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") return { status: "preserved", path };
  }
  if (existing !== undefined) {
    if (owned?.owner !== "astra-jev" || owned.sha256 !== digest(existing))
      return { status: "preserved", path };
    if (existing === content) return { status: "current", path };
  } else if (owned && owned.owner !== "astra-jev") {
    return { status: "preserved", path };
  }
  const temporary = join(directory, `.skill-${randomUUID()}.tmp`);
  const metadata = join(directory, `.skill-${randomUUID()}.tmp`);
  try {
    if (existing === undefined) await writeFile(path, content, { flag: "wx" });
    else {
      await writeFile(temporary, content, { flag: "wx" });
      if ((await readFile(path, "utf8")) !== existing)
        return { status: "preserved", path };
      await rename(temporary, path);
    }
    await writeFile(
      metadata,
      JSON.stringify({ owner: "astra-jev", sha256: digest(content) }) + "\n",
      { flag: "wx" },
    );
    await rename(metadata, marker);
    return { status: existing === undefined ? "installed" : "updated", path };
  } finally {
    await rm(temporary, { force: true });
    await rm(metadata, { force: true });
  }
}

export async function ensureSkill() {
  try {
    const result = await installSkill();
    if (result.status !== "current")
      console.error(
        result.status === "preserved"
          ? `Existing $astra-jev skill preserved at ${result.path}; it differs from the package-managed copy.`
          : `$astra-jev skill ${result.status}. Restart Codex if it is not listed yet.`,
      );
    return result;
  } catch (error) {
    console.error(
      `Could not install $astra-jev skill (${error.code ?? "installation failed"}). Retry with astra-jev-control install-skill.`,
    );
    return { status: "failed" };
  }
}
