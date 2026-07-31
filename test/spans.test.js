import assert from "node:assert/strict";
import { test } from "node:test";
import { SpanKind } from "@opentelemetry/api";
import { SpanTracker } from "../dist/spans.js";

// Minimal recording tracer — SpanTracker only needs startSpan + the handful of
// Span methods below, so no SDK / exporter is pulled in.
function recordingTracer() {
  const spans = [];
  return {
    spans,
    startSpan(name, opts) {
      const rec = {
        name,
        kind: opts?.kind,
        attributes: { ...(opts?.attributes ?? {}) },
      };
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

function run(spanNaming) {
  const tracer = recordingTracer();
  const tracker = new SpanTracker({
    tracer,
    captureContent: "metadata_only",
    spanNaming,
    cwd: "/tmp/wd",
    sessionId: () => "sess-1",
  });
  tracker.startInteraction("hello");
  tracker.startTurn(0);
  tracker.startLlmRequest("claude-sonnet-4");
  tracker.startTool("call-1", "bash", { cmd: "ls" });
  tracker.endTool("call-1", { isError: false });
  tracker.endLlmRequest();
  tracker.endTurn();
  tracker.endInteraction();
  return tracer.spans;
}

const OP = "gen_ai.operation.name";

test("legacy naming (default) keeps the pi.* span names and sets no SpanKind", () => {
  const [interaction, turn, llm, tool] = run("legacy");
  assert.equal(interaction.name, "pi.interaction");
  assert.equal(turn.name, "pi.turn");
  assert.equal(llm.name, "pi.llm_request");
  assert.equal(tool.name, "pi.tool.bash");
  for (const s of [interaction, turn, llm, tool]) {
    assert.equal(s.kind, undefined, `${s.name} must not set SpanKind`);
  }
  assert.equal(interaction.attributes[OP], undefined);
  assert.equal(turn.attributes[OP], undefined);
  assert.equal(llm.attributes[OP], "chat");
  assert.equal(tool.attributes[OP], undefined);
  assert.equal(interaction.attributes["gen_ai.agent.name"], undefined);
});

test("omitting spanNaming behaves exactly like legacy", () => {
  assert.deepEqual(run(undefined), run("legacy"));
});

test("genai naming emits spec span names, operation.name and SpanKind", () => {
  const [interaction, turn, llm, tool] = run("genai");
  assert.equal(interaction.name, "invoke_agent pi");
  assert.equal(interaction.attributes[OP], "invoke_agent");
  assert.equal(interaction.attributes["gen_ai.agent.name"], "pi");
  assert.equal(interaction.kind, SpanKind.INTERNAL);

  // pi.turn has no spec equivalent — unchanged vendor span.
  assert.equal(turn.name, "pi.turn");
  assert.equal(turn.kind, undefined);
  assert.equal(turn.attributes[OP], undefined);

  assert.equal(llm.name, "chat claude-sonnet-4");
  assert.equal(llm.attributes[OP], "chat");
  assert.equal(llm.kind, SpanKind.CLIENT);

  assert.equal(tool.name, "execute_tool bash");
  assert.equal(tool.attributes[OP], "execute_tool");
  assert.equal(tool.kind, SpanKind.INTERNAL);
});

test("chat span falls back to bare operation name when the model is unknown", () => {
  const tracer = recordingTracer();
  const tracker = new SpanTracker({
    tracer,
    captureContent: "metadata_only",
    spanNaming: "genai",
    cwd: "/tmp/wd",
    sessionId: () => undefined,
  });
  tracker.startInteraction("hi");
  tracker.startLlmRequest(undefined);
  assert.equal(tracer.spans[1].name, "chat");
});

test("genai mode only adds attributes — it never drops or rewrites them", () => {
  const legacy = run("legacy");
  const genai = run("genai");
  assert.equal(legacy.length, genai.length);
  for (let i = 0; i < legacy.length; i++) {
    // Every legacy attribute survives, byte-identical.
    for (const [k, v] of Object.entries(legacy[i].attributes)) {
      assert.equal(genai[i].attributes[k], v, `${legacy[i].name}.${k}`);
    }
    // The only additions are the two spec fields.
    const extra = Object.keys(genai[i].attributes).filter(
      (k) => !(k in legacy[i].attributes),
    );
    assert.deepEqual(
      extra.filter((k) => k !== OP && k !== "gen_ai.agent.name"),
      [],
    );
  }
});
