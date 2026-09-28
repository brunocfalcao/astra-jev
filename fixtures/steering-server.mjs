import { createInterface } from "node:readline";

import { callBridge } from "../src/hook-bridge.mjs";
const args = process.argv.slice(2);
const configs = args.filter((_, i) => args[i - 1] === "-c");
const hookArgs = configs.find((x) =>
  x.startsWith("mcp_servers.astra_jev_checkpoint.args="),
);
const bridgePath = hookArgs
  ? JSON.parse(hookArgs.slice(hookArgs.indexOf("=") + 1))[1]
  : null;
const hook = {
  handlerType: "mcpTool",
  server: "astra_jev_checkpoint",
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
};
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
let active = null,
  next = 0,
  review = false;
createInterface({ input: process.stdin }).on("line", async (line) => {
  const { id, method, params: p = {} } = JSON.parse(line);
  if (id === undefined) return;
  const reply = (result) => send({ id, result });
  const reject = (error) => send({ id, error });
  if (method === "initialize")
    reply({ userAgent: "astra_jev/0.157.1 fixture" });
  else if (method === "model/list")
    reply({
      data: [
        {
          model: "gpt-6-astra",
          defaultReasoningEffort: "low",
          supportedReasoningEfforts: ["low", "high"].map((reasoningEffort) => ({
            reasoningEffort,
          })),
        },
      ],
    });
  else if (method === "hooks/list")
    reply({ data: [{ hooks: bridgePath ? [hook] : [] }] });
  else if (method === "thread/resume") {
    if (bridgePath) await callBridge(bridgePath, { op: "ready" });
    reply({
      model: "gpt-6-astra",
      thread: { id: p.threadId, turns: [] },
      sandbox: { type: "readOnly" },
    });
  } else if (method === "turn/start") {
    if (!active) {
      active = { id: `turn-${++next}`, status: "inProgress" };
      send({
        method: "turn/started",
        params: { threadId: p.threadId, turn: active },
      });
    }
    reply({ turn: active, received: p });
  } else if (method === "turn/steer") {
    if (!active) reject({ code: -32600, message: "no active turn to steer" });
    else if (p.expectedTurnId !== active.id)
      reject({
        code: -32600,
        message: `expected active turn id \`${p.expectedTurnId}\` but found \`${active.id}\``,
      });
    else if (review)
      reject({
        code: -32600,
        message: "active turn does not support steering",
        data: {
          message: "Review input must be queued",
          codexErrorInfo: { activeTurnNotSteerable: { turnKind: "review" } },
        },
      });
    else reply({ turnId: active.id, received: p });
  } else if (method === "fixture/finish") {
    const turn = { ...active, status: "completed" };
    active = null;
    send({ method: "turn/completed", params: { threadId: p.threadId, turn } });
    reply({});
  } else if (method === "fixture/review") {
    review = p.enabled;
    reply({});
  } else if (method === "fixture/error") reject(p.error);
  else reply({});
});
