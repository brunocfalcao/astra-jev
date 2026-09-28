import { createInterface } from "node:readline";
import { spawn } from "node:child_process";

const send = (x) => process.stdout.write(JSON.stringify(x) + "\n");
const options = process.argv.slice(2);
const config = options.filter((_, i) => options[i - 1] === "-c");
const get = (key) => {
  const value = config.find((x) => x.startsWith(key + "="));
  return value ? JSON.parse(value.slice(key.length + 1)) : null;
};
const server = "astra_jev_checkpoint";
const args = get(`mcp_servers.${server}.args`);
let child,
  requestId = 0,
  currentEffort,
  turn = 0,
  trusted = false;
const pending = new Map();
const hook = {
  handlerType: "mcpTool",
  server,
  tool: "checkpoint",
  eventName: "postToolUse",
  source: "sessionFlags",
  sourcePath: "/<session-flags>/config.toml",
  displayOrder: 0,
  key: "/<session-flags>/config.toml:post_tool_use:0:0",
  matcher: ".*",
  currentHash: "fixture-hash",
  timeoutSec: 20,
  enabled: true,
  isManaged: false,
  trustStatus: "untrusted",
};
const rpc = (method, params) =>
  new Promise((resolve, reject) => {
    const id = ++requestId;
    pending.set(id, { resolve, reject });
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
    );
  });
async function boot() {
  if (!args || child) return;
  child = spawn(get(`mcp_servers.${server}.command`), args, {
    stdio: ["pipe", "pipe", "inherit"],
  });
  createInterface({ input: child.stdout }).on("line", (line) => {
    const m = JSON.parse(line),
      p = pending.get(m.id);
    if (p) {
      pending.delete(m.id);
      m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result);
    }
  });
  await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "fixture", version: "1" },
  });
  await rpc("tools/list", {});
}
createInterface({ input: process.stdin }).on("line", async (line) => {
  const m = JSON.parse(line),
    p = m.params ?? {};
  const reply = (result) => send({ id: m.id, result });
  if (m.method === "initialize")
    reply({ userAgent: "astra_jev/0.157.1 fixture" });
  else if (m.method === "config/read") reply({ config: {} });
  else if (m.method === "hooks/list")
    reply({
      data: [
        {
          cwd: process.cwd(),
          hooks: args ? [hook] : [],
          errors: [],
          warnings: [],
        },
      ],
    });
  else if (m.method === "model/list")
    reply({
      data: [
        {
          id: "gpt-6-astra",
          model: "gpt-6-astra",
          defaultReasoningEffort: "high",
          supportedReasoningEfforts: ["low", "high"].map((reasoningEffort) => ({
            reasoningEffort,
          })),
        },
      ],
    });
  else if (m.method === "thread/start") {
    await boot();
    trusted =
      p.config?.["hooks.state"]?.[hook.key]?.trusted_hash === hook.currentHash;
    reply({
      thread: { id: "thread-checkpoint", path: null },
      model: "gpt-6-astra",
    });
  } else if (m.method === "turn/settings/update") {
    currentEffort = p.effort;
    reply({ status: "applied" });
  } else if (m.method === "turn/start") {
    const turnId = `turn-${++turn}`,
      base = { threadId: "thread-checkpoint", turnId };
    const event = (method, rest) =>
      send({ method, params: { ...base, ...rest } });
    currentEffort = p.effort;
    reply({ turn: { id: turnId, status: "inProgress" } });
    event("turn/started", { turn: { id: turnId } });
    event("rawResponseItem/completed", {
      item: {
        type: "configuration_update",
        reasoning: { effort: currentEffort },
      },
    });
    event("rawResponse/completed", { responseId: `${turnId}-r1` });
    if (child && trusted)
      await rpc("tools/call", {
        name: "checkpoint",
        arguments: {
          session_id: base.threadId,
          turn_id: turnId,
          tool_use_id: "call-1",
          tool_name: "Bash",
          tool_input: { command: "synthetic read" },
          tool_response: "New complex evidence",
        },
      });
    event("rawResponseItem/completed", {
      item: {
        type: "function_call_output",
        call_id: "call-1",
        output: "New complex evidence",
      },
    });
    // Native execution captures immediately after tool completion, without awaiting notifications.
    event("rawResponseItem/completed", {
      item: {
        type: "configuration_update",
        reasoning: { effort: currentEffort },
      },
    });
    event("rawResponse/completed", { responseId: `${turnId}-r2` });
    event("item/agentMessage/delta", { delta: "CHECKPOINT_OK" });
    event("turn/completed", { turn: { id: turnId, status: "completed" } });
  } else if (m.id !== undefined) reply({});
});
process.stdin.on("end", () => child?.stdin.end());
