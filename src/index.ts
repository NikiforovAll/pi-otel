/**
 * pi-otel — OpenTelemetry traces for pi-coding-agent.
 *
 * Wires pi lifecycle events into an OTel span tree:
 *   pi.interaction (per user prompt)
 *   ├─ pi.llm_request
 *   └─ pi.tool.<name>
 *
 * See `_plans/SPEC.md` for the full design.
 *
 * The `/otel` command (Aspire launcher) is registered below via
 * `registerOtelCommand`. We also expose `pi.events` channels
 * (`pi-otel:status`, `pi-otel:trace-active`) for future consumers.
 *
 * ## pi-otel:log — extensibility API for other pi packages
 *
 * Any pi extension can route structured log records through pi-otel by emitting:
 *
 *   pi.events.emit("pi-otel:log", {
 *     eventName: "my-package.something",   // lands as event.name attribute
 *     severity: "info",                    // "debug" | "info" | "warn" | "error"
 *     body: "human-readable message",
 *     attributes: { "key": "value" },      // optional; string | number | boolean values
 *   });
 *
 * No-op if signals.logs is disabled or the OTel SDK is not yet initialized.
 * pi-otel uses this channel internally for its own lifecycle events.
 */

import { basename } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { trace } from "@opentelemetry/api";
import { SeverityNumber } from "@opentelemetry/api-logs";
import {
  ATTR_FINISH_REASONS,
  ATTR_HTTP_STATUS_CODE,
  ATTR_PI_CWD,
  ATTR_PI_SESSION_ID,
  ATTR_REQUEST_MODEL,
  ATTR_RESPONSE_ID,
  ATTR_RESPONSE_MODEL,
  ATTR_SYSTEM,
  applyUsageAttrs,
  GEN_AI_SYSTEM_PI,
} from "./attrs.js";
import { registerOtelCommand } from "./commands/otel.js";
import type { OtelConfig } from "./config.js";
import { normalizeProtocol, resolveConfig } from "./config.js";
import { emitLifecycleLog } from "./otel/logs.js";
import { initSdk, probeEndpoint, shutdownSdk } from "./otel/sdk.js";
import { SpanTracker } from "./spans.js";

const TRACER_NAME = "pi-otel";
const TRACER_VERSION = "0.1.0";

const SEVERITY_MAP: Record<string, SeverityNumber> = {
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
};

export default function (pi: ExtensionAPI): void {
  registerOtelCommand(pi, () => ctx0?.cwd);

  // pi-otel:log — any pi extension can emit structured log records through
  // pi-otel. No-op when signals.logs is disabled (LoggerProvider not registered).
  pi.events.on("pi-otel:log", (data: unknown) => {
    if (!data || typeof data !== "object") return;
    const {
      eventName = "pi-otel.log",
      severity = "info",
      body = "",
      attributes = {},
    } = data as {
      eventName?: string;
      severity?: string;
      body?: string;
      attributes?: Record<string, string | number | boolean>;
    };
    emitLifecycleLog(
      eventName,
      SEVERITY_MAP[severity] ?? SeverityNumber.INFO,
      body,
      attributes,
    );
  });

  let ctx0: ExtensionContext | undefined;
  let tracker: SpanTracker | null = null;
  let sessionIdRef: string | undefined;
  let sessionStartLogged = false;

  const notify = (
    msg: string,
    severity: "info" | "warning" | "error" = "info",
  ) => {
    try {
      ctx0?.ui?.notify?.(msg, severity);
    } catch {
      // best-effort
    }
  };

  function wireSdk(
    cfg: OtelConfig,
    opts: { silentSuccess?: boolean } = {},
  ): void {
    initSdk(cfg, notify, opts);
    const tracer = trace.getTracer(TRACER_NAME, TRACER_VERSION);
    tracker = new SpanTracker({
      tracer,
      captureContent: cfg.captureContent,
      cwd: cfg.cwd,
      sessionId: () => sessionIdRef,
    });
    pi.events.emit("pi-otel:status", {
      state: "ready",
      endpoint: cfg.endpoint,
    });
    // Fire once: wiring can happen at session_start OR later via dashboard-ready.
    if (!sessionStartLogged) {
      sessionStartLogged = true;
      pi.events.emit("pi-otel:log", {
        eventName: "pi.session.start",
        severity: "info",
        body: `pi session ${sessionIdRef ?? "(ephemeral)"} started`,
        attributes: {
          [ATTR_SYSTEM]: GEN_AI_SYSTEM_PI,
          [ATTR_PI_CWD]: cfg.cwd,
          "service.name": cfg.serviceName,
          ...(sessionIdRef ? { [ATTR_PI_SESSION_ID]: sessionIdRef } : {}),
        },
      });
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    ctx0 = ctx;
    const cfg = resolveConfig(ctx.cwd);
    if (!cfg.enabled) {
      tracker = null;
      return;
    }
    // Best-effort session id from the session manager.
    try {
      const file = ctx.sessionManager?.getSessionFile?.();
      if (file) sessionIdRef = basename(file, ".jsonl");
    } catch {
      // ignore
    }
    // Defer SDK init until the endpoint is reachable — otherwise the metric
    // reader / log processor begin retrying against a dead endpoint and the
    // resulting errors get buffered and flushed once it comes online.
    if (await probeEndpoint(cfg.endpoint)) {
      wireSdk(cfg);
    } else {
      notify(
        `pi-otel: OTLP endpoint ${cfg.endpoint} not reachable — run /otel start to launch a dashboard, or /otel connect <endpoint> to wire elsewhere.`,
      );
    }
  });

  const logError = (
    eventName: string,
    body: string,
    attrs: Record<string, string | number | boolean> = {},
  ) =>
    pi.events.emit("pi-otel:log", {
      eventName,
      severity: "error",
      body,
      attributes: attrs,
    });

  pi.on("before_agent_start", async (event, _ctx) => {
    tracker?.startInteraction(event?.prompt);
    const tid = tracker?.activeTraceId();
    if (tid) pi.events.emit("pi-otel:trace-active", { traceId: tid });
  });

  pi.on("turn_start", async (event, _ctx) => {
    const idx = (event as any)?.turnIndex;
    tracker?.startTurn(typeof idx === "number" ? idx : undefined);
  });

  pi.on("turn_end", async (_event, _ctx) => {
    tracker?.endTurn();
  });

  pi.on("message_start", async (event, _ctx) => {
    const msg = (event as any)?.message;
    if (!msg) return;
    if (msg.role === "user") {
      tracker?.noteUserMessage(msg.content);
    } else if (msg.role === "toolResult") {
      tracker?.noteToolResultMessage({
        toolCallId: msg.toolCallId,
        toolName: msg.toolName,
        content: msg.content,
      });
    }
  });

  pi.on("before_provider_request", async (event, _ctx) => {
    // event.payload shape varies per provider; try to lift a model field.
    const payload = (event as any)?.payload;
    const model =
      payload?.model ?? payload?.modelId ?? payload?.modelName ?? undefined;
    tracker?.startLlmRequest(typeof model === "string" ? model : undefined);
    if (typeof model === "string") {
      tracker?.setLlmAttrs({ [ATTR_REQUEST_MODEL]: model });
    }
  });

  pi.on("after_provider_response", async (event, _ctx) => {
    const status = (event as any)?.status;
    const headers = (event as any)?.headers ?? {};
    const attrs: Record<string, unknown> = {};
    if (typeof status === "number") attrs[ATTR_HTTP_STATUS_CODE] = status;
    // Common response-id headers across providers.
    const respId =
      headers["x-request-id"] ??
      headers["request-id"] ??
      headers["anthropic-request-id"] ??
      headers["openai-response-id"];
    if (typeof respId === "string") attrs[ATTR_RESPONSE_ID] = respId;
    tracker?.setLlmAttrs(attrs);
    // Note: end is deferred to message_end so we can attach usage/cost.
  });

  pi.on("message_end", async (event, _ctx) => {
    const msg = (event as any)?.message;
    if (!msg || msg.role !== "assistant") return;
    const attrs: Record<string, unknown> = {};
    if (typeof msg.model === "string") attrs[ATTR_RESPONSE_MODEL] = msg.model;
    const finish = msg.finishReason ?? msg.stopReason ?? msg.finish_reason;
    if (typeof finish === "string") attrs[ATTR_FINISH_REASONS] = [finish];
    applyUsageAttrs(attrs, msg.usage);
    tracker?.setLlmAttrs(attrs);
    tracker?.noteAssistantMessage(msg);
    tracker?.endLlmRequest();
    if (finish === "error") {
      logError(
        "pi.llm_request.error",
        msg.errorMessage ?? `LLM request failed (${finish})`,
        {
          ...(typeof msg.model === "string"
            ? { [ATTR_RESPONSE_MODEL]: msg.model }
            : {}),
          [ATTR_FINISH_REASONS]: finish,
        },
      );
    }
  });

  pi.on("tool_execution_start", async (event, _ctx) => {
    const e = event as any;
    if (!e?.toolCallId || !e?.toolName) return;
    tracker?.startTool(e.toolCallId, e.toolName, e.args);
  });

  pi.on("tool_execution_end", async (event, _ctx) => {
    const e = event as any;
    if (!e?.toolCallId) return;
    tracker?.endTool(e.toolCallId, { isError: !!e.isError, result: e.result });
    if (e.isError) {
      logError("pi.tool.error", `tool ${e.toolName} failed`, {
        "gen_ai.tool.name": e.toolName,
        "gen_ai.tool.call.id": e.toolCallId,
      });
    }
  });

  pi.on("agent_end", async (_event, _ctx) => {
    tracker?.endInteraction();
  });

  pi.on("session_shutdown", async (_event, _ctx) => {
    // Defensive: close any in-flight interaction before flushing.
    tracker?.endInteraction();
    pi.events.emit("pi-otel:log", {
      eventName: "pi.session.end",
      severity: "info",
      body: `pi session ${sessionIdRef ?? "(ephemeral)"} ended`,
      attributes: {
        [ATTR_SYSTEM]: GEN_AI_SYSTEM_PI,
        ...(sessionIdRef ? { [ATTR_PI_SESSION_ID]: sessionIdRef } : {}),
      },
    });
    await shutdownSdk();
    pi.events.emit("pi-otel:status", { state: "shutdown" });
    tracker = null;
  });

  // Anchor exported for the launcher extension. The launcher can call
  // `pi.events.emit("pi-otel:request-status", null)` and we reply with state.
  pi.events.on("pi-otel:request-status", () => {
    pi.events.emit("pi-otel:status", {
      state: tracker ? "ready" : "disabled",
    });
  });

  // Re-init the SDK when the dashboard becomes available mid-session, or when
  // `/otel connect` rewires us to an external collector. Without this, the
  // exporter keeps retrying against the dead endpoint it was wired to at
  // session_start. Payload `endpoint`/`protocol` override resolved config.
  pi.events.on("pi-otel:dashboard-ready", async (payload) => {
    if (!ctx0) return;
    const cfg = resolveConfig(ctx0.cwd);
    if (!cfg.enabled) return;
    const override = (payload ?? {}) as {
      endpoint?: string;
      protocol?: string;
    };
    if (typeof override.endpoint === "string" && override.endpoint) {
      cfg.endpoint = override.endpoint;
    }
    if (typeof override.protocol === "string" && override.protocol) {
      cfg.protocol = normalizeProtocol(override.protocol);
    }
    await shutdownSdk();
    // Caller (e.g. /otel start) already notified success; don't clobber it.
    wireSdk(cfg, { silentSuccess: true });
  });

  // TODO(SPEC §9 q1): inject TRACEPARENT into bash subprocesses once pi
  // exposes a subprocess-env hook for the bash tool.
  // TODO(SPEC §7 P3): redaction + truncation for captureContent != "full".
}
