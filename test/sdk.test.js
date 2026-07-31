import assert from "node:assert/strict";
import { test } from "node:test";
import { parseProbeTarget, resolveSignalUrl } from "../dist/otel/sdk.js";

test("http endpoint is a base url — each signal gets its own resource path", () => {
  const base = "https://logfire-eu.pydantic.dev";
  assert.equal(resolveSignalUrl(base, "traces"), `${base}/v1/traces`);
  assert.equal(resolveSignalUrl(base, "metrics"), `${base}/v1/metrics`);
  assert.equal(resolveSignalUrl(base, "logs"), `${base}/v1/logs`);
});

test("a base that already carries a signal path is not doubled up", () => {
  assert.equal(
    resolveSignalUrl("https://host/v1/traces", "metrics"),
    "https://host/v1/metrics",
  );
  assert.equal(
    resolveSignalUrl("http://localhost:4318/", "logs"),
    "http://localhost:4318/v1/logs",
  );
});

test("probe falls back to the scheme default port", () => {
  // No explicit port: `new URL(...).port` is "" — must probe 443, not bail out,
  // otherwise no SaaS OTLP backend on 443 can ever be wired.
  assert.deepEqual(parseProbeTarget("https://logfire-eu.pydantic.dev"), {
    host: "logfire-eu.pydantic.dev",
    port: 443,
  });
  assert.deepEqual(parseProbeTarget("http://example.com/v1/traces"), {
    host: "example.com",
    port: 80,
  });
  assert.deepEqual(parseProbeTarget("http://127.0.0.1:4318"), {
    host: "127.0.0.1",
    port: 4318,
  });
  assert.equal(parseProbeTarget("not a url"), null);
});
