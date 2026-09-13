import assert from "node:assert/strict";
import { test } from "node:test";
import { context as otelContext, propagation, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import {
  injectTraceContext,
  registerShellPropagation,
} from "../dist/shell-propagation.js";
import { SpanTracker } from "../dist/spans.js";

const cm = new AsyncLocalStorageContextManager().enable();
otelContext.setGlobalContextManager(cm);
propagation.setGlobalPropagator(new W3CTraceContextPropagator());
const provider = new BasicTracerProvider();
const tracer = provider.getTracer("test");

test("injectTraceContext leaves env alone without an active span", () => {
  const env = { PATH: "x" };
  assert.equal(injectTraceContext(env), env);
});

test("injectTraceContext writes W3C TRACEPARENT for the active span", () => {
  const span = tracer.startSpan("s");
  const ctx = trace.setSpan(otelContext.active(), span);
  const out = injectTraceContext({ PATH: "x" }, ctx);
  const { traceId, spanId } = span.spanContext();
  assert.equal(out.TRACEPARENT, `00-${traceId}-${spanId}-01`);
  assert.equal(out.PATH, "x");
  span.end();
});

test("registerShellPropagation overrides only active shell tools and injects the tool span", async () => {
  const tr = new SpanTracker({
    tracer,
    captureContent: "metadata_only",
    spanNaming: "legacy",
    cwd: process.cwd(),
    sessionId: () => "sess",
  });
  tr.startInteraction("hi");
  tr.startTurn(0);
  tr.startTool("call-1", "bash", { command: "true" });
  const toolSpan = trace.getSpan(tr.toolContext("call-1"));
  const { traceId, spanId } = toolSpan.spanContext();

  const registered = [];
  const pi = {
    getActiveTools: () => ["read", "bash"],
    registerTool: (t) => registered.push(t),
  };
  const names = registerShellPropagation(pi, process.cwd(), () => tr);
  assert.deepEqual(names, ["bash"]);
  assert.equal(registered.length, 1);
  assert.equal(registered[0].name, "bash");

  // Use the override's execute path against a real spawn; the hook must see
  // the tool span even though execute runs outside any OTel context.
  const res = await registered[0].execute(
    "call-1",
    { command: 'echo "$TRACEPARENT"' },
    new AbortController().signal,
    () => {},
  );
  const text = res.content.map((c) => c.text ?? "").join("");
  assert.match(text, new RegExp(`00-${traceId}-${spanId}-01`));
  tr.endTool("call-1", { isError: false, result: res });
});
