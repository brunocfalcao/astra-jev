import {
  readFile,
  writeFile,
  link,
  unlink,
  rename,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

export const defaults = Object.freeze({
  version: 1,
  enabled: true,
  verbose: true,
  fixedEffort: null,
  effortAdjustment: "default",
  requireJev: false,
});

async function replaceIfUnchanged(path, before, next) {
  const temporary = join(dirname(path), `.astra-jev-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(next, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    if ((await readFile(path, "utf8")) !== before) return false;
    await rename(temporary, path);
    return true;
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

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
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await readFile(path, "utf8");
    let value;
    try {
      value = JSON.parse(before);
    } catch {
      throw new Error(
        "Cannot read astra-jev.json as JSON; existing file was preserved",
      );
    }
    const config = resolveConfig(value);
    if (Object.hasOwn(value, "effortAdjustment")) return config;
    if (
      await replaceIfUnchanged(path, before, {
        ...value,
        effortAdjustment: defaults.effortAdjustment,
      })
    )
      return config;
  }
  throw new Error("Project settings changed during upgrade; retry with the current file");
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
    !["conservative", "default", "optimistic"].includes(config.effortAdjustment) ||
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
  if (!(await replaceIfUnchanged(path, before, next)))
    throw new Error(
      "Project settings changed during this update; retry with the current file",
    );
  return config;
}
