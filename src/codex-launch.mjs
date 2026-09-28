import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { constants } from "node:os";

const commands = new Set(
  "agents exec e review login logout mcp plugin app-server remote-control app completion update doctor sandbox debug apply a resume queue archive delete migrate-rollouts unarchive fork cloud exec-server features help".split(
    " ",
  ),
);
const valued = new Set([
  "-C",
  "--cd",
  "-c",
  "--config",
  "-m",
  "--model",
  "-i",
  "--image",
  "-s",
  "--sandbox",
  "-a",
  "--ask-for-approval",
  "--enable",
  "--disable",
  "-p",
  "--profile",
  "--add-dir",
  "--remote",
  "--remote-auth-token-env",
  "--local-provider",
]);
const flags = new Set([
  "--no-alt-screen",
  "--search",
  "--strict-config",
  "--last",
  "--all",
  "--include-non-interactive",
  "--approve-for-me",
  "--dangerously-bypass-approvals-and-sandbox",
  "--dangerously-bypass-hook-trust",
  "--no-daemon",
  "--worktree",
  "--oss",
]);
const directOptions = new Set([
  "--remote",
  "--remote-auth-token-env",
  "--no-daemon",
  "--worktree",
  "--add-dir",
  "-p",
  "--profile",
  "--oss",
  "--local-provider",
  "--dangerously-bypass-hook-trust",
]);

// This scanner chooses the integration, never rewrites or rejects user argv.
// Unknown syntax belongs to Codex, including its validation and future flags.
export function planLaunch(args, cwd = process.cwd()) {
  const initialCwd = cwd;
  let command,
    positional = false,
    reason,
    permissionOverride = false,
    externalRemote = false,
    hasModel = false,
    hasCwd = false;
  const config = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") break;
    if (!arg.startsWith("-")) {
      if (!positional && commands.has(arg)) command = arg;
      positional = true;
      if (command && !["resume", "exec", "e", "review"].includes(command))
        break;
      continue;
    }
    let [name] = arg.split("=", 1);
    let value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : undefined;
    if (/^-[Ccimsap].+/.test(arg) && !arg.startsWith("--") && arg[2] !== "=") {
      name = arg.slice(0, 2);
      value = arg.slice(2);
    }
    if (["--help", "-h", "--version", "-V"].includes(name))
      reason = "Codex information command";
    else if (!valued.has(name) && !flags.has(name))
      reason = "option handled by stock Codex";
    if (valued.has(name) && value === undefined) value = args[++i];
    if (valued.has(name) && value === undefined)
      reason = "Codex argument validation";
    if (["-C", "--cd"].includes(name) && value) {
      cwd = resolve(initialCwd, value);
      hasCwd = true;
    }
    if (directOptions.has(name))
      reason = "option requires stock Codex's own runtime";
    if (name === "--remote") externalRemote = true;
    if (["-m", "--model"].includes(name)) {
      hasModel = true;
      if (value !== "gpt-6-astra")
        reason = "Jev integration supports Astra only";
    }
    if (
      [
        "-s",
        "--sandbox",
        "-a",
        "--ask-for-approval",
        "--approve-for-me",
        "--dangerously-bypass-approvals-and-sandbox",
      ].includes(name)
    )
      permissionOverride = true;
    if (["-c", "--config"].includes(name) && value) {
      config.push(value);
      const key = value.split("=", 1)[0].trim();
      if (/^(permissions|sandbox|approval|approvals)/.test(key))
        permissionOverride = true;
      // Do not silently override explicit settings that conflict with Jev's
      // model, effort or checkpoint requirements.
      if (
        (/^(model|features|hooks|mcp_servers)/.test(key) &&
          !["features.shell_snapshot", "features.shell_snapshot_v2"].includes(
            key,
          )) ||
        /["']/.test(key)
      )
        reason = "configuration requires stock Codex ownership";
    }
    if (["--enable", "--disable"].includes(name) && value) {
      config.push(`features.${value}=${name === "--enable"}`);
      if (
        ["step_model_switching", "reasoning_effort_override", "hooks"].includes(
          value,
        )
      )
        reason = "feature changes Jev's required runtime";
    }
  }
  if (command && command !== "resume")
    reason = "Codex subcommand runs directly";
  if (command === "resume" && permissionOverride)
    reason = "stock remote resume cannot apply permission overrides";
  return {
    cwd: externalRemote ? initialCwd : cwd,
    command,
    resume: command === "resume",
    config,
    direct: !!reason,
    reason,
    defaults: [
      ...(hasModel ? [] : ["--model", "gpt-6-astra"]),
      ...(hasCwd ? [] : ["--cd", initialCwd]),
    ],
  };
}

export function exitCode({ code, signal }) {
  return code ?? (signal ? 128 + (constants.signals[signal] ?? 1) : 1);
}

export async function runCodex(args, { spawnImpl = spawn } = {}) {
  const env = { ...process.env };
  delete env.TYPESAFE_API_KEY;
  const child = spawnImpl("codex", args, {
    env,
    stdio: "inherit",
    shell: false,
  });
  const forward = (signal) => child.kill(signal);
  const handlers = ["SIGINT", "SIGTERM"].map((signal) => {
    const handler = () => forward(signal);
    process.on(signal, handler);
    return [signal, handler];
  });
  try {
    return await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
}
