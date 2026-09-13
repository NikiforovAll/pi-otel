import assert from "node:assert/strict";
import { test } from "node:test";
import { DiagLogLevel, metrics, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import {
  foreignOtelProviders,
  initSdk,
  shutdownSdk,
} from "../dist/otel/sdk.js";

const cfg = {
  enabled: true,
  endpoint: "http://127.0.0.1:1",
  protocol: "http/protobuf",
  headers: {},
  serviceName: "pi-otel-test",
  captureContent: "metadata_only",
  spanNaming: "legacy",
  sampleRatio: 1,
  signals: { traces: true, metrics: false, logs: false },
  resourceAttributes: {},
  logLevel: DiagLogLevel.NONE,
  cwd: process.cwd(),
};

const fakeTracerProvider = { getTracer: () => trace.getTracer("x") };
const fakeMeterProvider = { getMeter: () => metrics.getMeter("x") };
const fakeLoggerProvider = { getLogger: () => logs.getLogger("x") };

function clearGlobals() {
  trace.disable();
  metrics.disable();
  logs.disable();
}

test("no foreign providers on a clean process", () => {
  clearGlobals();
  assert.deepEqual(foreignOtelProviders(), []);
});

test("detects each foreign provider kind through the api global registry", () => {
  clearGlobals();
  assert.equal(trace.setGlobalTracerProvider(fakeTracerProvider), true);
  assert.deepEqual(foreignOtelProviders(), ["trace"]);
  metrics.setGlobalMeterProvider(fakeMeterProvider);
  logs.setGlobalLoggerProvider(fakeLoggerProvider);
  assert.deepEqual(foreignOtelProviders(), ["trace", "metrics", "logs"]);
  clearGlobals();
  assert.deepEqual(foreignOtelProviders(), []);
});

test("initSdk bails with one warning when another SDK owns the globals", async () => {
  clearGlobals();
  trace.setGlobalTracerProvider(fakeTracerProvider);
  const notes = [];
  const notify = (msg, severity) => notes.push({ msg, severity });

  assert.equal(initSdk(cfg, notify), null);
  assert.equal(initSdk(cfg, notify), null);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].severity, "warning");
  assert.match(notes[0].msg, /another OpenTelemetry SDK/);
  assert.match(notes[0].msg, /\(trace\)/);
  assert.match(notes[0].msg, /PI_OTEL_DISABLED=1/);

  // The foreign provider is untouched and our own SDK never started.
  assert.equal(trace.getTracerProvider().getDelegate(), fakeTracerProvider);
  await shutdownSdk();
  clearGlobals();
});

test("own init, shutdown, and re-init is not mistaken for a foreign SDK", async () => {
  clearGlobals();
  const notes = [];
  const notify = (msg, severity) => notes.push({ msg, severity });

  const first = initSdk(cfg, notify, { silentSuccess: true });
  assert.ok(first, "first init starts the SDK");
  assert.ok(foreignOtelProviders().includes("trace"));
  await shutdownSdk();
  assert.deepEqual(foreignOtelProviders(), []);

  // shutdownSdk leaves the context manager and propagator registered; the
  // check must ignore them.
  const second = initSdk(cfg, notify, { silentSuccess: true });
  assert.ok(second, "re-init after own shutdown starts again");
  assert.notEqual(second, first);
  assert.equal(
    notes.filter((n) => n.severity === "warning").length,
    0,
    JSON.stringify(notes),
  );
  await shutdownSdk();
  clearGlobals();
});
