export function redact(value, secrets = []) {
  let text = String(value ?? "");
  for (const secret of secrets)
    if (secret?.length >= 4) text = text.split(secret).join("[redacted]");
  return text
    .replace(/(Authorization:\s*Bearer\s+)\S+/gi, "$1[redacted]")
    .replace(
      /\b((?:[\w-]{0,64}(?:api[_-]?key|password|secret|access[_-]?token|refresh[_-]?token))[\w-]{0,32}["']?\s*[=:]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi,
      "$1[redacted]",
    )
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[redacted]")
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
      "[redacted private key]",
    );
}
const preview = (s, max) =>
  s.length <= max
    ? s
    : s.slice(0, Math.floor(max / 2)) +
      "\n[truncated]\n" +
      s.slice(-Math.floor(max / 2));

// Hook results can contain MCP media blocks. Only textual/structured public data
// belongs in Jev's state; never stringify encrypted or binary content blocks.
export function publicToolData(value, depth = 0) {
  if (depth > 12) return "[nested content omitted]";
  if (
    typeof value === "string" ||
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return value;
  if (Array.isArray(value))
    return value
      .slice(0, 100)
      .map((v) => publicToolData(v, depth + 1))
      .filter((v) => v !== undefined);
  if (!value || typeof value !== "object") return undefined;
  if (value.type && /image|audio|video|reasoning|resource/i.test(value.type))
    return undefined;
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([k]) => !/encrypted|base64|image|audio|blob|private.*key/i.test(k),
      )
      .slice(0, 100)
      .map(([k, v]) => [k, publicToolData(v, depth + 1)])
      .filter(([, v]) => v !== undefined),
  );
}
export class Context {
  constructor({ secrets = [] } = {}) {
    this.secrets = secrets;
    this.reset("");
  }
  clean(value, max = 4000) {
    return this.bounded(value, max).text;
  }
  bounded(value, max) {
    const text = redact(
      typeof value === "string" ? value : JSON.stringify(value ?? ""),
      this.secrets,
    );
    return { text: preview(text, max), truncated: text.length > max };
  }
  toolOutput(value) {
    // Keep excerpts, not inferred risk labels. Both positive and negative
    // diagnostics remain untrusted evidence for Jev to interpret in context.
    const text = redact(
      typeof value === "string" ? value : JSON.stringify(value ?? ""),
      this.secrets,
    );
    const bounded = {
      text: preview(text, 3000),
      truncated: text.length > 3000,
    };
    if (!bounded.truncated) return bounded;
    // Structured tool text often contains escaped newlines inside JSON.
    const lines = text.replaceAll("\\n", "\n").split("\n");
    const excerpts = [];
    let diagnosticCount = 0;
    for (let i = 0; i < lines.length; i++) {
      if (
        /\b(?:conflict\w*|incompatib\w*|warning\w*|error\w*|failed|blocked|denied|lock[- ]file|preserv\w*)\b/i.test(
          lines[i],
        )
      ) {
        excerpts.push(
          this.clean(lines.slice(Math.max(0, i - 1), i + 3).join("\n"), 500),
        );
        diagnosticCount++;
        if (excerpts.length > 3) excerpts.shift();
        i += 2;
      }
    }
    if (excerpts.length) {
      bounded.diagnosticExcerpt = this.clean(
        excerpts.slice(-3).join("\n[...]\n"),
        1200,
      );
      bounded.omittedDiagnosticExcerpts = Math.max(0, diagnosticCount - 3);
    }
    return bounded;
  }
  reset(prompt) {
    const bounded = this.bounded(prompt, 8000);
    this.prompt = bounded.text;
    this.promptTruncated = bounded.truncated;
    this.originalPrompt = this.prompt;
    this.originalPromptTruncated = this.promptTruncated;
    this.userPromptCount = this.prompt ? 1 : 0;
    this.prior = [];
    this.notes = [];
    this.noteCount = 0;
    this.outputCount = 0;
    this.plan = null;
    this.historyScope = "bounded_live_public_events";
    this.failures = new Map();
    this.calls = new Map();
    this.outputs = [];
    this.hookOutputs = new Set();
  }
  nextTurn(prompt) {
    this.addPrompt(prompt);
    this.failures.clear();
    this.calls.clear();
    this.hookOutputs.clear();
  }
  addPrompt(prompt) {
    if (this.prompt) this.prior.push(this.clean(this.prompt, 2000));
    this.prior = this.prior.slice(-3);
    const bounded = this.bounded(prompt, 8000);
    this.prompt = bounded.text;
    this.promptTruncated = bounded.truncated;
    if (!this.originalPrompt && this.prompt) {
      this.originalPrompt = this.prompt;
      this.originalPromptTruncated = this.promptTruncated;
    }
    if (this.prompt) this.userPromptCount++;
  }
  addHook(event) {
    this.hookOutputs.add(event.tool_use_id);
    if (this.hookOutputs.size > 64)
      this.hookOutputs.delete(this.hookOutputs.values().next().value);
    const input = this.bounded(publicToolData(event.tool_input), 1800);
    const output = this.toolOutput(publicToolData(event.tool_response));
    this.outputCount++;
    this.outputs.push({
      name: this.clean(event.tool_name, 120),
      input: input.text,
      output: output.text,
      diagnosticExcerpt: output.diagnosticExcerpt,
      omittedDiagnosticExcerpts: output.omittedDiagnosticExcerpts,
      userPromptIndex: this.userPromptCount,
      truncation: { input: input.truncated, output: output.truncated },
    });
    this.outputs = this.outputs.slice(-6);
  }
  hydrate(turns = []) {
    // Walk user messages without retaining all old content. Public findings are
    // restored only from recent turns; the first request remains identifiable.
    this.reset("");
    this.historyScope = "resumed_user_history_and_recent_public_messages";
    for (const [index, turn] of turns.entries())
      for (const item of turn.items ?? []) {
        if (item.type === "userMessage")
          this.nextTurn(
            (item.content ?? [])
              .filter((x) => x.type === "text")
              .map((x) => x.text)
              .join("\n"),
          );
        if (item.type === "agentMessage" && index >= turns.length - 3)
          this.add({
            type: "message",
            role: "assistant",
            phase: item.phase ?? "final_answer",
            content: [{ type: "output_text", text: item.text }],
          });
      }
  }
  setPlan({ explanation, plan }) {
    if (!Array.isArray(plan)) return;
    this.plan = {
      explanation: this.clean(explanation ?? "", 1000),
      steps: plan
        .slice(0, 12)
        .map((p) => ({ step: this.clean(p.step, 240), status: p.status })),
      truncated:
        plan.length > 12 ||
        (explanation?.length ?? 0) > 1000 ||
        plan.some((p) => p.step?.length > 240),
    };
  }
  addFailure(item) {
    const id = item.id ?? `unidentified-${this.failures.size}`;
    this.failures.set(id, {
      type: item.type,
      status: item.status,
      ...(Number.isInteger(item.exitCode) ? { exitCode: item.exitCode } : {}),
    });
  }
  stats() {
    return {
      userPrompts: this.userPromptCount,
      toolCalls: this.outputs.length,
      omittedOlderToolCalls: Math.max(
        0,
        this.outputCount - this.outputs.length,
      ),
      publicNotes: this.notes.length,
      toolFailures: this.failures.size,
      truncatedToolCalls: this.outputs.filter(
        (x) => x.truncation?.input || x.truncation?.output,
      ).length,
      diagnosticToolCalls: this.outputs.filter((x) => x.diagnosticExcerpt)
        .length,
      omittedDiagnosticExcerpts: this.outputs.reduce(
        (sum, x) => sum + (x.omittedDiagnosticExcerpts ?? 0),
        0,
      ),
      planPresent: this.plan !== null,
    };
  }
  add(item) {
    if (!item || typeof item !== "object") return;
    if (
      item.type === "message" &&
      item.role === "assistant" &&
      ["commentary", "final_answer"].includes(item.phase)
    ) {
      this.noteCount++;
      this.notes.push(
        this.clean(
          (item.content ?? [])
            .filter((x) => x.type === "output_text")
            .map((x) => x.text)
            .join("\n"),
          1500,
        ),
      );
      this.notes = this.notes.slice(-4);
    }
    if (["function_call", "custom_tool_call"].includes(item.type)) {
      const input = this.bounded(item.arguments ?? item.input, 1800);
      this.calls.set(item.call_id, {
        name: this.clean(item.name, 120),
        input: input.text,
        truncation: { input: input.truncated },
      });
      if (this.calls.size > 32)
        this.calls.delete(this.calls.keys().next().value);
    }
    if (
      ["function_call_output", "custom_tool_call_output"].includes(item.type)
    ) {
      if (this.hookOutputs.has(item.call_id)) {
        this.calls.delete(item.call_id);
        return;
      }
      const output = this.toolOutput(
        Array.isArray(item.output)
          ? item.output
              .filter((x) => x.type === "input_text")
              .map((x) => x.text)
              .join("\n")
          : typeof item.output === "string"
            ? item.output
            : "",
      );
      const call = this.calls.get(item.call_id);
      this.outputCount++;
      this.outputs.push({
        ...call,
        output: output.text,
        diagnosticExcerpt: output.diagnosticExcerpt,
        omittedDiagnosticExcerpts: output.omittedDiagnosticExcerpts,
        userPromptIndex: this.userPromptCount,
        truncation: {
          input: call?.truncation.input ?? false,
          output: output.truncated,
        },
      });
      this.outputs = this.outputs.slice(-6);
      this.calls.delete(item.call_id);
    }
  }
  state(extra = {}) {
    return {
      model: this.model ?? "gpt-6-astra",
      latestUserPrompt: this.prompt,
      userPromptIndex: this.userPromptCount,
      originalUserPrompt: this.originalPrompt,
      priorUserPrompts: [...this.prior],
      publicNotes: [...this.notes],
      currentPlan: this.plan,
      attachments: {
        images: this.imageCount ?? 0,
        imageContentVisibleToEvaluator: false,
      },
      recentToolCalls: [...this.outputs],
      recentToolFailures: [...this.failures.values()].slice(-6),
      historyScope: this.historyScope ?? "bounded_live_public_events",
      omittedOlderUserPrompts: Math.max(
        0,
        this.userPromptCount -
          this.prior.length -
          1 -
          (this.userPromptCount > 4 ? 1 : 0),
      ),
      omittedOlderToolCalls: Math.max(
        0,
        this.outputCount - this.outputs.length,
      ),
      omittedOlderPublicNotes: Math.max(0, this.noteCount - this.notes.length),
      contextLimits: {
        promptCharacters: 8000,
        toolCalls: 6,
        toolOutputCharacters: 3000,
        diagnosticExcerptCharacters: 1200,
        hiddenReasoningIncluded: false,
        latestPromptTruncated: this.promptTruncated,
        originalPromptTruncated: this.originalPromptTruncated,
      },
      ...extra,
    };
  }
}
