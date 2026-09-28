import test from "node:test";
import assert from "node:assert/strict";
import { Jev } from "../src/jev.mjs";

const state = { model: "gpt-6-astra", supportedEfforts: ["low"] };
const good = () =>
  new Response(
    JSON.stringify({
      model: "jev-1.13.0",
      answers: {
        effort: { type: "choice", choice: "low" },
        lease: { type: "choice", choice: "1" },
      },
    }),
  );

test("transient HTTP errors retry the same typed request within one deadline", async () => {
  const requests = [],
    waits = [];
  let clock = 1000;
  const j = new Jev({
    key: "fixture",
    now: () => clock,
    sleep: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
    fetchImpl: async (url, options) => {
      requests.push({ url, body: options.body, signal: options.signal });
      return requests.length === 1
        ? new Response("private-provider-error", {
            status: 503,
            headers: { "retry-after": "1" },
          })
        : good();
    },
  });
  const decision = await j.decide(state);
  assert.equal(decision.attempts, 2);
  assert.deepEqual(waits, [1000]);
  assert.equal(requests[0].url, requests[1].url);
  assert.equal(requests[0].body, requests[1].body);
  assert.equal(requests[0].signal, requests[1].signal);
});

test("retry count, cancellation, permanent errors and large Retry-After stay bounded", async () => {
  for (const [status, expected, timeoutMs] of [
    [503, 3, 8000],
    [401, 1, 8000],
    [429, 1, 1000],
  ]) {
    let calls = 0,
      clock = 1000;
    const j = new Jev({
      key: "fixture",
      timeoutMs,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      fetchImpl: async () => {
        calls++;
        return new Response("credential-in-provider-body", {
          status,
          headers: status === 429 ? { "retry-after": "60" } : {},
        });
      },
    });
    await assert.rejects(
      () => j.decide(state),
      new RegExp(`^Error: Jev HTTP ${status}$`),
    );
    assert.equal(calls, expected);
  }
  const abort = new AbortController();
  let calls = 0;
  const j = new Jev({
    key: "fixture",
    sleep: async () => abort.abort(),
    fetchImpl: async () => {
      calls++;
      return new Response("", { status: 503 });
    },
  });
  await assert.rejects(
    () => j.decide(state, { signal: abort.signal }),
    /cancelled/,
  );
  assert.equal(calls, 1);
});

test("oversized evaluator requests stay local and never reach TypeSafe", async () => {
  let calls = 0;
  const j = new Jev({
    key: "fixture",
    fetchImpl: async () => {
      calls++;
      return good();
    },
  });
  await assert.rejects(
    () => j.decide({ ...state, latestUserPrompt: "x".repeat(200000) }),
    /request exceeds/,
  );
  assert.equal(calls, 0);
});
