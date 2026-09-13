import assert from "node:assert/strict";
import { test } from "node:test";
import { SpanTracker } from "../dist/spans.js";

const SYNTH = "pi.llm_request.synthesized";

function recordingTracer() {
  const spans = [];
  return {
    spans,
    startSpan(name, opts) {
      const rec = { name, attributes: { ...(opts?.attributes ?? {}) } };
      spans.push(rec);
      return {
        setAttribute(k, v) {
          rec.attributes[k] = v;
        },
        setStatus() {},
        addEvent() {},
        end() {},
        spanContext: () => ({
          traceId: "0".repeat(32),
          spanId: "0".repeat(16),
        }),
      };
    },
  };
}

function tracker() {
  const t = recordingTracer();
  const tr = new SpanTracker({
    tracer: t,
    captureContent: "metadata_only",
    spanNaming: "legacy",
    cwd: "/tmp/wd",
    sessionId: () => "sess-1",
  });
  tr.startInteraction("hello");
  tr.startTurn(0);
  return { t, tr };
}

test("normal path: before_provider_request span carries no synthesized marker", () => {
  const { t, tr } = tracker();
  tr.startLlmRequest("m1", "openai");
  assert.equal(tr.hasOpenLlmRequest(), true);
  tr.endLlmRequest();
  assert.equal(tr.hasOpenLlmRequest(), false);
  const llm = t.spans.find((s) => s.name === "pi.llm_request");
  assert.equal(llm.attributes[SYNTH], undefined);
});

test("fallback path: message_start-opened span is tagged synthesized", () => {
  const { t, tr } = tracker();
  assert.equal(tr.hasOpenLlmRequest(), false);
  tr.startLlmRequest("vertex-model", "google-vertex", { synthesized: true });
  tr.setLlmAttrs({ "gen_ai.usage.input_tokens": 12 });
  tr.endLlmRequest();
  const llm = t.spans.find((s) => s.name === "pi.llm_request");
  assert.equal(llm.attributes[SYNTH], true);
  assert.equal(llm.attributes["gen_ai.request.model"], "vertex-model");
  assert.equal(llm.attributes["gen_ai.usage.input_tokens"], 12);
});

test("hasOpenLlmRequest lets the handler skip the fallback when a span is already open", () => {
  const { t, tr } = tracker();
  tr.startLlmRequest("m1", "openai");
  // What index.ts does on assistant message_start.
  if (!tr.hasOpenLlmRequest()) {
    tr.startLlmRequest("m1", "openai", { synthesized: true });
  }
  tr.endLlmRequest();
  const llms = t.spans.filter((s) => s.name === "pi.llm_request");
  assert.equal(llms.length, 1);
  assert.equal(llms[0].attributes[SYNTH], undefined);
});
