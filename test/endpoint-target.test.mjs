import assert from "node:assert/strict";
import test from "node:test";
import { endpointTarget } from "../dist/otel/sdk.js";

test("resolves explicit OTLP ports", () => {
  assert.deepEqual(endpointTarget("http://127.0.0.1:4317"), {
    host: "127.0.0.1",
    port: 4317,
  });
  assert.deepEqual(endpointTarget("http://localhost:4318/v1/traces"), {
    host: "localhost",
    port: 4318,
  });
});

test("resolves default HTTP and HTTPS ports", () => {
  assert.deepEqual(endpointTarget("https://api.honeycomb.io"), {
    host: "api.honeycomb.io",
    port: 443,
  });
  assert.deepEqual(endpointTarget("https://example.com:443/v1/traces"), {
    host: "example.com",
    port: 443,
  });
  assert.deepEqual(endpointTarget("http://example.com"), {
    host: "example.com",
    port: 80,
  });
});

test("rejects endpoints without a resolvable target", () => {
  assert.equal(endpointTarget("grpc://localhost"), null);
  assert.equal(endpointTarget("not a URL"), null);
});
