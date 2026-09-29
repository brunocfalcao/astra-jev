import test from "node:test";
import assert from "node:assert/strict";
import { Context, redact } from "../src/context.mjs";
import { Jev, validateDecision, loadKey } from "../src/jev.mjs";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("bounded state excludes hidden reasoning and masks known keys and credential assignments", () => {
  const c = new Context({ secrets: ["test-key-123456789"] });
  c.reset("Inspect synthetic code; password=secretvalue");
  c.add({
    type: "reasoning",
    summary: [{ text: "PRIVATE_REASONING" }],
    encrypted_content: "PRIVATE_CIPHER",
  });
  c.add({
    type: "message",
    role: "assistant",
    phase: "commentary",
    content: [
      { type: "output_text", text: "Public status test-key-123456789" },
    ],
  });
  for (let i = 0; i < 20; i++) {
    c.add({
      type: "function_call",
      call_id: String(i),
      name: "read",
      arguments: "{}",
    });
    c.add({
      type: "function_call_output",
      call_id: String(i),
      output: "x".repeat(20000),
    });
  }
  const state = c.state();
  const text = JSON.stringify(state);
  assert.equal(state.recentToolCalls.length, 6);
  assert.ok(Buffer.byteLength(text) <= 96 * 1024);
  for (const secret of [
    "PRIVATE_REASONING",
    "PRIVATE_CIPHER",
    "test-key-123456789",
    "secretvalue",
  ])
    assert.equal(text.includes(secret), false);
  assert.ok(text.includes("Public status"));
  assert.ok(text.includes("[truncated]"));
  assert.equal(
    redact("Authorization: Bearer abcdef123456"),
    "Authorization: Bearer [redacted]",
  );
  assert.equal(
    redact('{"api_key":"secret-in-json"}').includes("secret-in-json"),
    false,
  );
  c.add({
    type: "function_call_output",
    call_id: "binary",
    output: [
      { type: "input_text", text: "visible result" },
      { type: "encrypted_content", encrypted_content: "PRIVATE_TOOL_CIPHER" },
      { type: "input_image", image_url: "PRIVATE_IMAGE_DATA" },
    ],
  });
  const toolText = JSON.stringify(c.state());
  assert.ok(toolText.includes("visible result"));
  assert.equal(toolText.includes("PRIVATE_TOOL_CIPHER"), false);
  assert.equal(toolText.includes("PRIVATE_IMAGE_DATA"), false);
});

test("a follow-up retains bounded prior user goals and public findings", () => {
  const c = new Context();
  c.reset("Investigate the ALPHA invariant");
  c.add({
    type: "message",
    role: "assistant",
    phase: "final_answer",
    content: [{ type: "output_text", text: "ALPHA requires deduplication." }],
  });
  c.nextTurn("Continue");
  assert.equal(c.state().latestUserPrompt, "Continue");
  assert.deepEqual(c.state().priorUserPrompts, [
    "Investigate the ALPHA invariant",
  ]);
  assert.ok(c.state().publicNotes.some((x) => x.includes("deduplication")));
});

test("only supported Astra efforts and exact allowed leases are accepted", () => {
  const good = {
    model: "jev-1.13.0",
    answers: {
      effort: { type: "choice", choice: "high" },
      lease: { type: "choice", choice: "2" },
    },
    usage: { input_tokens: 8, output_tokens: 2 },
  };
  assert.deepEqual(validateDecision(good, ["low", "high"]).effort, "high");
  for (const change of [{ effort: "none" }, { lease: "3" }, { lease: "02" }]) {
    const x = structuredClone(good);
    for (const [key, value] of Object.entries(change))
      x.answers[key].choice = value;
    assert.throws(() => validateDecision(x, ["low", "high"]));
  }
  assert.throws(() => validateDecision({ ...good, model: "other" }, ["high"]));
  assert.throws(() => validateDecision(null, ["high"]));
});

test("Jev sends one authenticated typed request and never returns provider error bodies", async () => {
  const sent = [];
  const j = new Jev({
    key: "test-key",
    fetchImpl: async (url, options) => {
      sent.push({ url, options });
      return new Response(
        JSON.stringify({
          model: "jev-1.13.0",
          answers: {
            effort: { type: "choice", choice: "low" },
            lease: { type: "choice", choice: "1" },
          },
        }),
        { status: 200 },
      );
    },
  });
  const d = await j.decide({
    model: "gpt-6-astra",
    supportedEfforts: ["low", "high"],
    latestUserPrompt: "Synthetic task",
  });
  assert.equal(d.effort, "low");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, "https://api.typesafe.ai/v1/systemone");
  const body = JSON.parse(sent[0].options.body);
  assert.deepEqual(Object.keys(body.questions), ["effort", "lease"]);
  assert.deepEqual(Object.keys(body.questions.effort.criteria), [
    "low",
    "high",
  ]);
  const bad = new Jev({
    key: "secret",
    fetchImpl: async () =>
      new Response("secret credential echoed", { status: 401 }),
  });
  await assert.rejects(
    () => bad.decide({ model: "gpt-6-astra", supportedEfforts: ["low"] }),
    /^Error: Jev HTTP 401$/,
  );
});

test("credential loading reads only the named key without evaluating shell content", () => {
  const dir = mkdtempSync(join(tmpdir(), "astra-jev-key-test-"));
  const file = join(dir, "credentials");
  try {
    writeFileSync(
      file,
      'UNRELATED=unused\nTYPESAFE_API_KEY="fixture-value" # test\n',
    );
    assert.equal(loadKey({ env: {}, paths: [file] }), "fixture-value");
    assert.equal(
      loadKey({ env: { TYPESAFE_API_KEY: "env-fixture" }, paths: [] }),
      "env-fixture",
    );
    assert.throws(() => loadKey({ env: {}, paths: [] }));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("provider retry-after prevents repeated calls until the stated delay expires", async () => {
  let now = 1000,
    calls = 0;
  const j = new Jev({
    key: "fixture",
    timeoutMs: 4000,
    now: () => now,
    fetchImpl: async () => {
      calls++;
      return new Response("", { status: 429, headers: { "retry-after": "5" } });
    },
  });
  const state = { model: "gpt-6-astra", supportedEfforts: ["low"] };
  await assert.rejects(() => j.decide(state), /HTTP 429/);
  await assert.rejects(() => j.decide(state), /retry deferred/);
  assert.equal(calls, 1);
  now += 5000;
  await assert.rejects(() => j.decide(state), /HTTP 429/);
  assert.equal(calls, 2);
});
