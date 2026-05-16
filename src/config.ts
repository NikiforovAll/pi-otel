/**
 * Resolve pi-otel configuration from `.pi/settings.json` + env vars.
 *
 * Precedence: env vars (OTEL_* / PI_OTEL_*) override settings.json `otel.*`.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DiagLogLevel } from "@opentelemetry/api";
import type { ContentCapture } from "./attrs.js";

export interface OtelConfig {
  enabled: boolean;
  endpoint: string;
  protocol: "grpc" | "http/protobuf" | "http/json";
  headers: Record<string, string>;
  serviceName: string;
  captureContent: ContentCapture;
  sampleRatio: number;
  signals: {
    traces: boolean;
    metrics: boolean;
    logs: boolean;
  };
  resourceAttributes: Record<string, string>;
  logLevel: DiagLogLevel;
  cwd: string;
}

interface SettingsShape {
  otel?: Partial<{
    enabled: boolean;
    endpoint: string;
    protocol: string;
    headers: Record<string, string>;
    serviceName: string;
    captureContent: ContentCapture | boolean;
    sampleRatio: number;
    signals: Partial<{ traces: boolean; metrics: boolean; logs: boolean }>;
    logLevel: string;
  }>;
}

function tryReadJson(path: string): SettingsShape | null {
  try {
    const text = readFileSync(path, "utf8");
    return JSON.parse(text) as SettingsShape;
  } catch (e: any) {
    if (e?.code === "ENOENT") return null;
    return null;
  }
}

function parseKvList(
  s: string | undefined,
  decode = false,
): Record<string, string> {
  if (!s) return {};
  const out: Record<string, string> = {};
  for (const pair of s.split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const k = pair.slice(0, eq).trim();
    if (!k) continue;
    const rawV = pair.slice(eq + 1).trim();
    let v = rawV;
    if (decode) {
      try {
        v = decodeURIComponent(rawV);
      } catch {
        // Fall back to raw value on malformed %-escapes (per W3C resource attrs spec).
      }
    }
    out[k] = v;
  }
  return out;
}

function normalizeProtocol(
  p: string | undefined,
): "grpc" | "http/protobuf" | "http/json" {
  if (!p) return "grpc";
  const v = p.trim().toLowerCase();
  if (v === "grpc") return "grpc";
  if (v === "http/protobuf" || v === "http-protobuf" || v === "http")
    return "http/protobuf";
  if (v === "http/json") return "http/json";
  return "grpc";
}

function normalizeLogLevel(s: string | undefined): DiagLogLevel | undefined {
  if (!s) return undefined;
  switch (s.trim().toLowerCase()) {
    case "none":
      return DiagLogLevel.NONE;
    case "error":
      return DiagLogLevel.ERROR;
    case "warn":
    case "warning":
      return DiagLogLevel.WARN;
    case "info":
      return DiagLogLevel.INFO;
    case "debug":
      return DiagLogLevel.DEBUG;
    case "verbose":
    case "trace":
      return DiagLogLevel.VERBOSE;
    case "all":
      return DiagLogLevel.ALL;
    default:
      return undefined;
  }
}

function normalizeCapture(v: unknown): ContentCapture {
  if (v === true || v === "full") return "full";
  if (v === "no_tool_content") return "no_tool_content";
  return "metadata_only";
}

export function resolveConfig(cwd: string): OtelConfig {
  const projectSettings = tryReadJson(join(cwd, ".pi", "settings.json"));
  const globalSettings = tryReadJson(
    join(homedir(), ".pi", "agent", "settings.json"),
  );
  const merged: SettingsShape["otel"] = {
    ...(globalSettings?.otel ?? {}),
    ...(projectSettings?.otel ?? {}),
  };

  const envDisabled =
    process.env.PI_OTEL_DISABLED === "1" ||
    process.env.PI_OTEL_DISABLED === "true";

  const enabled = envDisabled ? false : merged?.enabled !== false;

  const endpoint =
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??
    merged?.endpoint ??
    "http://127.0.0.1:4317";

  const protocol = normalizeProtocol(
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL ?? merged?.protocol,
  );

  const headers = {
    ...(merged?.headers ?? {}),
    ...parseKvList(process.env.OTEL_EXPORTER_OTLP_HEADERS),
  };

  const serviceName =
    process.env.OTEL_SERVICE_NAME ?? merged?.serviceName ?? "pi";

  const captureContent = normalizeCapture(
    process.env.PI_OTEL_CAPTURE_CONTENT ?? merged?.captureContent,
  );

  const sampleRatio =
    typeof merged?.sampleRatio === "number" ? merged.sampleRatio : 1.0;

  const envTrue = (v: string | undefined): boolean => v === "1" || v === "true";

  return {
    enabled,
    endpoint,
    protocol,
    headers,
    serviceName,
    captureContent,
    sampleRatio,
    signals: {
      traces: merged?.signals?.traces !== false,
      metrics:
        envTrue(process.env.PI_OTEL_METRICS) ||
        merged?.signals?.metrics === true,
      logs: envTrue(process.env.PI_OTEL_LOGS) || merged?.signals?.logs === true,
    },
    resourceAttributes: parseKvList(process.env.OTEL_RESOURCE_ATTRIBUTES, true),
    logLevel:
      normalizeLogLevel(process.env.OTEL_LOG_LEVEL) ??
      normalizeLogLevel(merged?.logLevel) ??
      DiagLogLevel.DEBUG,
    cwd,
  };
}
