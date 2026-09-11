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

test("scheme-less and non-http endpoints are rejected, not probed", () => {
  // new URL("localhost:4318") parses with protocol "localhost:" and empty
  // hostname — must NOT fall back to 127.0.0.1:80 (regression guard).
  assert.equal(parseProbeTarget("localhost:4318"), null);
  assert.equal(parseProbeTarget("unix:///var/run/otlp.sock"), null);
});

test("query strings survive signal path resolution", () => {
  assert.equal(
    resolveSignalUrl("https://host/otlp?api-key=abc", "traces"),
    "https://host/otlp/v1/traces?api-key=abc",
  );
  // Cross-signal: strip the stale signal path, keep the query.
  assert.equal(
    resolveSignalUrl("http://c:4318/v1/traces?tenant=x", "metrics"),
    "http://c:4318/v1/metrics?tenant=x",
  );
});

test("fragments are dropped; unparseable bases keep legacy concat", () => {
  assert.equal(
    resolveSignalUrl("https://host/otlp#frag", "logs"),
    "https://host/otlp/v1/logs",
  );
  assert.equal(resolveSignalUrl("not a url", "traces"), "not a url/v1/traces");
});
