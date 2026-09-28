import { readFile, writeFile, link, unlink, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

export const defaults = Object.freeze({
  version: 1,
  enabled: true,
  verbose: true,
  fixedEffort: null,
  requireJev: false,
});

export async function projectConfig(cwd) {
  const path = join(cwd, "astra-jev.json");
  // Publish complete JSON atomically without replacing an existing file.
  const temporary = join(cwd, `.astra-jev-${randomUUID()}.tmp`);
  try {
    await readFile(path, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await writeFile(temporary, JSON.stringify(defaults, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    try {
      await link(temporary, path);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    } finally {
      await unlink(temporary);
    }
  }
  let value;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(
      "Cannot read astra-jev.json as JSON; existing file was preserved",
    );
  }
  return resolveConfig(value);
}

function resolveConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("astra-jev.json must contain a JSON object");
  // Older releases generated native-runtime overrides. Accept old files
  // without applying or rewriting those obsolete fields.
  const settings = { ...value };
  delete settings.resumePermissions;
  delete settings.noAltScreen;
  if (Object.keys(settings).some((key) => !Object.hasOwn(defaults, key)))
    throw new Error(
      `Unknown astra-jev.json setting; supported: ${Object.keys(defaults).join(", ")}`,
    );
  const config = { ...defaults, ...settings };
  if (
    config.version !== 1 ||
    typeof config.enabled !== "boolean" ||
    typeof config.verbose !== "boolean" ||
    typeof config.requireJev !== "boolean" ||
    ![null, "low", "medium", "high", "xhigh", "max", "ultra"].includes(
      config.fixedEffort,
    )
  )
    throw new Error(
      "Invalid astra-jev.json settings; see the README for supported values",
    );
  if (config.requireJev && (!config.enabled || config.fixedEffort))
    throw new Error("requireJev requires enabled: true and fixedEffort: null");
  return config;
}

export async function setProjectSetting(cwd, key, value) {
  if (key === "version" || !Object.hasOwn(defaults, key))
    throw new Error(`Unknown configurable setting: ${key}`);
  await projectConfig(cwd);
  const path = join(cwd, "astra-jev.json");
  const before = await readFile(path, "utf8");
  const next = { ...JSON.parse(before), [key]: value };
  const config = resolveConfig(next);
  const temporary = join(cwd, `.astra-jev-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(next, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    if ((await readFile(path, "utf8")) !== before)
      throw new Error(
        "Project settings changed during this update; retry with the current file",
      );
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  return config;
}
