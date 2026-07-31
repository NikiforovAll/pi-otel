/**
 * OTel SDK bootstrap. One global SDK per process — pi loads us per session
 * but the SDK is shared across sessions in the same process.
 */

import { randomBytes } from "node:crypto";
import { createConnection } from "node:net";
import { diag, metrics, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { OTLPLogExporter as LogGrpcExporter } from "@opentelemetry/exporter-logs-otlp-grpc";
import { OTLPLogExporter as LogHttpExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPLogExporter as LogProtoExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { OTLPMetricExporter as MetricGrpcExporter } from "@opentelemetry/exporter-metrics-otlp-grpc";
import { OTLPMetricExporter as MetricHttpExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPMetricExporter as MetricProtoExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter as GrpcExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { OTLPTraceExporter as HttpExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPTraceExporter as ProtoExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { Resource } from "@opentelemetry/resources";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-base";
import {
  ATTR_SERVICE_INSTANCE_ID,
  ATTR_SERVICE_NAME,
} from "@opentelemetry/semantic-conventions/incubating";
import { ATTR_PI_CWD } from "../attrs.js";
import type { OtelConfig } from "../config.js";
import { buildBridgeDiagLogger, resetLogHandles } from "./logs.js";
import { resetMetricHandles } from "./metrics.js";

export type NotifySeverity = "info" | "warning" | "error";
export type Notify = (msg: string, severity?: NotifySeverity) => void;

let sdk: NodeSDK | null = null;
let initOnce = false;

export function probeTcp(
  host: string,
  port: number,
  timeoutMs = 300,
): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ port, host });
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

// Used at session_start to avoid wiring exporters at a dead endpoint —
// otherwise the metric reader / log processor begin retrying immediately and
// those failures get buffered and flushed once the endpoint comes online.
export function probeEndpoint(
  endpoint: string,
  timeoutMs = 300,
): Promise<boolean> {
  const target = parseProbeTarget(endpoint);
  if (!target) return Promise.resolve(false);
  return probeTcp(target.host, target.port, timeoutMs);
}

/** null on an unparseable endpoint. */
export function parseProbeTarget(
  endpoint: string,
): { host: string; port: number } | null {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return null;
  }
  // SaaS OTLP backends are served on the scheme default port (Node strips it,
  // so `u.port` is ""), so fall back to 80/443 rather than refusing to probe.
  return {
    host: u.hostname || "127.0.0.1",
    port: u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80,
  };
}

export type Signal = "traces" | "metrics" | "logs";

/**
 * HTTP OTLP is per-signal: the configured endpoint is a BASE url and each
 * signal appends its own resource path. gRPC uses the base endpoint as-is.
 * A base that already carries a signal path is tolerated (older configs).
 */
export function resolveSignalUrl(endpoint: string, signal: Signal): string {
  const base = endpoint
    .replace(/\/+$/, "")
    .replace(/\/v1\/(?:traces|metrics|logs)$/, "");
  return `${base}/v1/${signal}`;
}

type ExporterCtor<T> = new (opts: {
  url: string;
  headers: Record<string, string>;
}) => T;

function pickByProtocol<T>(
  cfg: OtelConfig,
  signal: Signal,
  ctors: {
    grpc: ExporterCtor<T>;
    proto: ExporterCtor<T>;
    http: ExporterCtor<T>;
  },
): T {
  if (cfg.protocol === "grpc")
    return new ctors.grpc({ url: cfg.endpoint, headers: cfg.headers });
  const opts = {
    url: resolveSignalUrl(cfg.endpoint, signal),
    headers: cfg.headers,
  };
  if (cfg.protocol === "http/protobuf") return new ctors.proto(opts);
  return new ctors.http(opts);
}

export function initSdk(
  cfg: OtelConfig,
  notify?: Notify,
  opts: { silentSuccess?: boolean } = {},
): NodeSDK | null {
  if (!cfg.enabled || !cfg.signals.traces) return null;
  if (initOnce) return sdk;
  initOnce = true;

  const instanceId = `${process.pid}-${randomBytes(4).toString("hex")}`;
  const resource = new Resource({
    ...cfg.resourceAttributes,
    [ATTR_SERVICE_NAME]: cfg.serviceName,
    [ATTR_SERVICE_INSTANCE_ID]: instanceId,
    [ATTR_PI_CWD]: cfg.cwd,
  });

  const traceExporter = pickByProtocol(cfg, "traces", {
    grpc: GrpcExporter,
    proto: ProtoExporter,
    http: HttpExporter,
  });
  const spanProcessor = new BatchSpanProcessor(traceExporter);

  const sampler =
    cfg.sampleRatio < 1.0
      ? new ParentBasedSampler({
          root: new TraceIdRatioBasedSampler(cfg.sampleRatio),
        })
      : undefined;

  const sdkOpts: Record<string, unknown> = {
    resource,
    spanProcessor,
    ...(sampler ? { sampler } : {}),
  };
  if (cfg.signals.metrics) {
    const metricExporter = pickByProtocol(cfg, "metrics", {
      grpc: MetricGrpcExporter,
      proto: MetricProtoExporter,
      http: MetricHttpExporter,
    });
    sdkOpts.metricReader = new PeriodicExportingMetricReader({
      exporter: metricExporter,
      exportIntervalMillis: 10_000,
    });
  }
  if (cfg.signals.logs) {
    const logExporter = pickByProtocol(cfg, "logs", {
      grpc: LogGrpcExporter,
      proto: LogProtoExporter,
      http: LogHttpExporter,
    });
    sdkOpts.logRecordProcessors = [new BatchLogRecordProcessor(logExporter)];
  }

  sdk = new NodeSDK(sdkOpts as ConstructorParameters<typeof NodeSDK>[0]);

  try {
    sdk.start();
  } catch (err) {
    const e = err as Error;
    notify?.(`pi-otel: SDK start failed — ${e.message}`, "error");
    sdk = null;
    initOnce = false;
    return null;
  }

  // Install bridge AFTER sdk.start() — LoggerProvider must exist first.
  if (cfg.signals.logs) {
    diag.setLogger(buildBridgeDiagLogger(), {
      logLevel: cfg.logLevel,
      suppressOverrideMessage: true,
    });
  }

  if (!opts.silentSuccess) {
    notify?.(
      `pi-otel: OTLP wired to ${cfg.endpoint} (${cfg.protocol})`,
      "info",
    );
  }
  return sdk;
}

export async function shutdownSdk(): Promise<void> {
  if (!sdk) return;
  try {
    await sdk.shutdown();
  } catch {
    // swallow — silent-drop policy (SPEC §7)
  } finally {
    // Reset state first so a subsequent initSdk() can proceed even if the
    // cleanup calls below throw. The global Tracer/Logger/Meter APIs refuse
    // to replace an already-registered provider — without disabling all
    // three, a re-init silently keeps the dead providers.
    sdk = null;
    initOnce = false;
    trace.disable();
    metrics.disable();
    logs.disable();
    diag.disable();
    resetMetricHandles();
    resetLogHandles();
  }
}
