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

function run(spanNaming, provider = "openai") {
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
  tracker.startLlmRequest("claude-sonnet-4", provider);
  tracker.startTool("call-1", "bash", { cmd: "ls" });
  tracker.endTool("call-1", { isError: false });
  tracker.endLlmRequest();
  tracker.endTurn();
  tracker.endInteraction();
  return tracer.spans;
}

const OP = "gen_ai.operation.name";
const PROVIDER = "gen_ai.provider.name";

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
  // Legacy never carries provider metadata, even though run() passes one.
  for (const s of [interaction, turn, llm, tool]) {
    assert.equal(s.attributes[PROVIDER], undefined, `${s.name}.${PROVIDER}`);
  }
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
  assert.equal(llm.attributes[PROVIDER], "openai");

  assert.equal(tool.name, "execute_tool bash");
  assert.equal(tool.attributes[OP], "execute_tool");
  assert.equal(tool.kind, SpanKind.INTERNAL);
  // Provider metadata is chat-only — never on agent/turn/tool spans.
  assert.equal(interaction.attributes[PROVIDER], undefined);
  assert.equal(turn.attributes[PROVIDER], undefined);
  assert.equal(tool.attributes[PROVIDER], undefined);
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
    // The only additions are the two spec fields, plus provider on the
    // chat span only (index 2: interaction, turn, llm, tool).
    const extra = Object.keys(genai[i].attributes).filter(
      (k) => !(k in legacy[i].attributes),
    );
    const allowed =
      i === 2 ? [OP, "gen_ai.agent.name", PROVIDER] : [OP, "gen_ai.agent.name"];
    assert.deepEqual(
      extra.filter((k) => !allowed.includes(k)),
      [],
    );
    if (i === 2)
      assert.ok(extra.includes(PROVIDER), "chat span must add provider");
  }
});

// --- gen_ai.provider.name (genai chat spans only) -------------------------

function newTracker(spanNaming = "genai", captureContent = "metadata_only") {
  const tracer = recordingTracer();
  const tracker = new SpanTracker({
    tracer,
    captureContent,
    spanNaming,
    cwd: "/tmp/wd",
    sessionId: () => "sess-1",
  });
  return { tracer, tracker };
}

test("provider normalization: aliases, canonical/custom passthrough, trimming, prototype-safe keys", () => {
  const cases = [
    ["amazon-bedrock", "aws.bedrock"],
    ["azure-openai-responses", "azure.ai.openai"],
    ["google", "gcp.gemini"],
    ["google-vertex", "gcp.vertex_ai"],
    ["kimi-coding", "moonshot_ai"],
    ["moonshotai", "moonshot_ai"],
    ["moonshotai-cn", "moonshot_ai"],
    ["mistral", "mistral_ai"],
    ["xai", "x_ai"],
    ["openai-codex", "openai"],
    ["openai", "openai"],
    ["some-custom-provider", "some-custom-provider"],
    ["openrouter", "openrouter"],
    ["  mistral  ", "mistral_ai"],
    ["__proto__", "__proto__"],
    ["constructor", "constructor"],
    ["toString", "toString"],
    [undefined, undefined],
    [null, undefined],
    [42, undefined],
    ["", undefined],
    ["   ", undefined],
  ];

  for (const [input, expected] of cases) {
    const { tracer, tracker } = newTracker();
    tracker.startInteraction("hi");
    tracker.startLlmRequest("m", input);
    assert.equal(
      tracer.spans[1].attributes[PROVIDER],
      expected,
      `normalize(${JSON.stringify(input)})`,
    );
    assert.equal(
      Object.hasOwn(tracer.spans[1].attributes, PROVIDER),
      expected !== undefined,
    );
    assert.equal(tracer.spans[1].attributes["gen_ai.system"], "pi");
  }
});

test("provider set at span creation from the request-start value", () => {
  const { tracer, tracker } = newTracker();
  tracker.startInteraction("hi");
  tracker.startLlmRequest("claude-sonnet-4", "anthropic");
  assert.equal(tracer.spans[1].attributes[PROVIDER], "anthropic");
});

test("response provider corrects/fills the request-start value before the metadata_only early return", () => {
  const { tracer, tracker } = newTracker("genai", "metadata_only");
  tracker.startInteraction("hi");
  tracker.startLlmRequest("m", "openai");
  tracker.noteAssistantMessage({ provider: "anthropic", content: "hi" });
  assert.equal(
    tracer.spans[1].attributes[PROVIDER],
    "anthropic",
    "response provider must correct the request-start guess even under metadata_only",
  );
});

test("response provider fills an absent request-start value", () => {
  const { tracer, tracker } = newTracker();
  tracker.startInteraction("hi");
  tracker.startLlmRequest("m"); // no provider known at request start
  assert.equal(tracer.spans[1].attributes[PROVIDER], undefined);
  tracker.noteAssistantMessage({ provider: "mistral", content: "hi" });
  assert.equal(tracer.spans[1].attributes[PROVIDER], "mistral_ai");
});

test("absent/non-string/blank response provider preserves the known request-start value", () => {
  for (const badResponseProvider of [undefined, null, 42, {}, [], "", "   "]) {
    const { tracer, tracker } = newTracker();
    tracker.startInteraction("hi");
    tracker.startLlmRequest("m", "openai");
    tracker.noteAssistantMessage({
      provider: badResponseProvider,
      content: "hi",
    });
    assert.equal(
      tracer.spans[1].attributes[PROVIDER],
      "openai",
      `bad response provider ${JSON.stringify(badResponseProvider)} must not clobber request-start value`,
    );
  }
});

test("neither request-start nor response provider known: attribute is omitted entirely", () => {
  const { tracer, tracker } = newTracker();
  tracker.startInteraction("hi");
  tracker.startLlmRequest("m"); // no provider
  tracker.noteAssistantMessage({ content: "hi" }); // no provider
  assert.equal("gen_ai.provider.name" in tracer.spans[1].attributes, false);
});

test("legacy and implicit-default naming never set provider despite valid request/response providers", () => {
  for (const explicitNaming of [true, false]) {
    const tracer = recordingTracer();
    const opts = {
      tracer,
      captureContent: "metadata_only",
      cwd: "/tmp/wd",
      sessionId: () => "sess-1",
    };
    // Implicit-default case omits spanNaming from opts entirely, rather than
    // passing `undefined` through a defaulted parameter (which would silently
    // re-trigger the "genai" default and defeat this assertion).
    if (explicitNaming) opts.spanNaming = "legacy";
    const tracker = new SpanTracker(opts);
    tracker.startInteraction("hi");
    tracker.startLlmRequest("m", "openai");
    tracker.noteAssistantMessage({ provider: "anthropic", content: "hi" });
    assert.equal(tracer.spans[1].attributes[PROVIDER], undefined);
  }
});

test("provider metadata never appears on interaction, turn, or tool spans", () => {
  const { tracer, tracker } = newTracker();
  tracker.startInteraction("hi");
  tracker.startTurn(0);
  tracker.startLlmRequest("m", "openai");
  tracker.startTool("call-1", "bash", { cmd: "ls" });
  tracker.endTool("call-1", { isError: false });
  tracker.noteAssistantMessage({ provider: "anthropic", content: "hi" });
  tracker.endLlmRequest();
  tracker.endTurn();
  tracker.endInteraction();
  const [interaction, turn, llm, tool] = tracer.spans;
  assert.equal(llm.attributes[PROVIDER], "anthropic");
  for (const s of [interaction, turn, tool]) {
    assert.equal(
      s.attributes[PROVIDER],
      undefined,
      `${s.name} must not carry provider`,
    );
  }
});

test("provider never caches across successive LLM requests: switch and unknown-after-known", () => {
  const { tracer, tracker } = newTracker();
  tracker.startInteraction("hi");

  tracker.startLlmRequest("m1", "openai");
  tracker.noteAssistantMessage({ content: "r1" }); // no response provider
  tracker.endLlmRequest();

  tracker.startLlmRequest("m2", "anthropic");
  tracker.noteAssistantMessage({ content: "r2" });
  tracker.endLlmRequest();

  tracker.startLlmRequest("m3"); // unknown request provider after two known ones
  tracker.noteAssistantMessage({ content: "r3" });
  tracker.endLlmRequest();

  const llmSpans = tracer.spans.filter((s) => s.attributes[OP] === "chat");
  assert.equal(llmSpans.length, 3);
  assert.equal(llmSpans[0].attributes[PROVIDER], "openai");
  assert.equal(llmSpans[1].attributes[PROVIDER], "anthropic");
  assert.equal(
    "gen_ai.provider.name" in llmSpans[2].attributes,
    false,
    "third request must not inherit the previous request's provider",
  );
});

test("an LLM request that errors before any response preserves the request-start provider", () => {
  const { tracer, tracker } = newTracker();
  tracker.startInteraction("hi");
  tracker.startLlmRequest("m", "openai");
  // No noteAssistantMessage() call — request failed before a response arrived.
  tracker.endLlmRequest(new Error("boom"));
  assert.equal(tracer.spans[1].attributes[PROVIDER], "openai");
});

test("provider metadata is present across capture modes (metadata_only, no_tool_content, full)", () => {
  for (const captureContent of ["metadata_only", "no_tool_content", "full"]) {
    const { tracer, tracker } = newTracker("genai", captureContent);
    tracker.startInteraction("hi");
    tracker.startLlmRequest("m", "openai");
    tracker.noteAssistantMessage({ provider: "anthropic", content: "hi" });
    assert.equal(
      tracer.spans[1].attributes[PROVIDER],
      "anthropic",
      `captureContent=${captureContent}`,
    );
  }
});
