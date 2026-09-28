import { createInterface } from "node:readline";
import { callBridge } from "../src/hook-bridge.mjs";

// This process only relays the native hook. It never loads credentials or runs tools.
const socket = process.argv[2];
const send = (value) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
const calls = new Map();
const fields = [
  "session_id",
  "turn_id",
  "tool_use_id",
  "tool_name",
  "tool_input",
  "tool_response",
];
const tool = {
  name: "checkpoint",
  description: "Internal native lifecycle checkpoint. Do not call directly.",
  inputSchema: {
    type: "object",
    required: fields,
    additionalProperties: false,
    properties: Object.fromEntries(
      fields.map((k) => [
        k,
        k.startsWith("tool_") && ["tool_input", "tool_response"].includes(k)
          ? {}
          : { type: "string" },
      ]),
    ),
  },
};
const lines = createInterface({ input: process.stdin });
lines.on("line", async (line) => {
  if (Buffer.byteLength(line) > 4 * 1024 * 1024) return;
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (!m || typeof m !== "object" || Array.isArray(m)) return;
  if (m.method === "notifications/cancelled") {
    calls.get(m.params?.requestId)?.abort();
    return;
  }
  if (m.id === undefined) return;
  try {
    let result;
    if (m.method === "initialize") {
      await callBridge(socket, { op: "ready" });
      result = {
        protocolVersion: m.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "astra-jev-checkpoint", version: "0.3.0" },
      };
    } else if (m.method === "tools/list") result = { tools: [tool] };
    else if (m.method === "ping") result = {};
    else if (m.method === "tools/call" && m.params?.name === "checkpoint") {
      const abort = new AbortController();
      calls.set(m.id, abort);
      try {
        await callBridge(
          socket,
          { op: "checkpoint", params: m.params.arguments },
          { signal: abort.signal },
        );
        result = { content: [{ type: "text", text: "{}" }] };
      } catch {
        // Native PostToolUse feedback alone is not a turn-stop guarantee. The
        // owner observes this hook's stopped/failed event and interrupts its turn.
        result = {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                continue: false,
                stopReason:
                  "Jev checkpoint unavailable; restart or use fixed effort.",
              }),
            },
          ],
        };
      } finally {
        calls.delete(m.id);
      }
    } else {
      send({
        id: m.id,
        error: { code: -32601, message: "Unsupported checkpoint method" },
      });
      return;
    }
    send({ id: m.id, result });
  } catch {
    send({
      id: m.id,
      error: { code: -32603, message: "Checkpoint unavailable" },
    });
  }
});
lines.on("close", () => {
  for (const abort of calls.values()) abort.abort();
});
