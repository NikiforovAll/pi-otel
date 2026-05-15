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
 */

import { basename } from "node:path";
import { trace } from "@opentelemetry/api";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveConfig } from "./config.js";
import { initSdk, shutdownSdk } from "./otel/sdk.js";
import { SpanTracker } from "./spans.js";
import { registerOtelCommand } from "./commands/otel.js";
import { emitLifecycleLog } from "./otel/logs.js";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { ATTR_PI_SESSION_ID, ATTR_PI_CWD, ATTR_SYSTEM, GEN_AI_SYSTEM_PI } from "./attrs.js";
import {
  ATTR_HTTP_STATUS_CODE,
  ATTR_RESPONSE_ID,
  ATTR_RESPONSE_MODEL,
  ATTR_REQUEST_MODEL,
  ATTR_FINISH_REASONS,
  applyUsageAttrs,
} from "./attrs.js";

const TRACER_NAME = "pi-otel";
const TRACER_VERSION = "0.1.0";

export default function (pi: ExtensionAPI): void {
  registerOtelCommand(pi);

  let ctx0: ExtensionContext | undefined;
  let tracker: SpanTracker | null = null;
  let sessionIdRef: string | undefined;

  const notify = (msg: string, severity: "info" | "warning" | "error" = "info") => {
    try {
      ctx0?.ui?.notify?.(msg, severity);
    } catch {
      // best-effort
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    ctx0 = ctx;
    const cfg = resolveConfig(ctx.cwd);
    if (!cfg.enabled) {
      tracker = null;
      return;
    }
    initSdk(cfg, notify);
    const tracer = trace.getTracer(TRACER_NAME, TRACER_VERSION);
    tracker = new SpanTracker({
      tracer,
      captureContent: cfg.captureContent,
      cwd: cfg.cwd,
      sessionId: () => sessionIdRef,
    });
    // Best-effort session id from the session manager.
    try {
      const file = ctx.sessionManager?.getSessionFile?.();
      if (file) sessionIdRef = basename(file, ".jsonl");
    } catch {
      // ignore
    }
    pi.events.emit("pi-otel:status", { state: "ready", endpoint: cfg.endpoint });
    emitLifecycleLog(
      "pi.session.start",
      SeverityNumber.INFO,
      `pi session ${sessionIdRef ?? "(ephemeral)"} started`,
      {
        [ATTR_SYSTEM]: GEN_AI_SYSTEM_PI,
        [ATTR_PI_CWD]: cfg.cwd,
        "service.name": cfg.serviceName,
        ...(sessionIdRef ? { [ATTR_PI_SESSION_ID]: sessionIdRef } : {}),
      },
    );
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
  });

  pi.on("agent_end", async (_event, _ctx) => {
    tracker?.endInteraction();
  });

  pi.on("session_shutdown", async (_event, _ctx) => {
    // Defensive: close any in-flight interaction before flushing.
    tracker?.endInteraction();
    emitLifecycleLog(
      "pi.session.end",
      SeverityNumber.INFO,
      `pi session ${sessionIdRef ?? "(ephemeral)"} ended`,
      {
        [ATTR_SYSTEM]: GEN_AI_SYSTEM_PI,
        ...(sessionIdRef ? { [ATTR_PI_SESSION_ID]: sessionIdRef } : {}),
      },
    );
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
    const override = (payload ?? {}) as { endpoint?: string; protocol?: string };
    if (typeof override.endpoint === "string" && override.endpoint) {
      cfg.endpoint = override.endpoint;
    }
    if (typeof override.protocol === "string" && override.protocol) {
      cfg.protocol = override.protocol as typeof cfg.protocol;
    }
    await shutdownSdk();
    initSdk(cfg, notify);
    const tracer = trace.getTracer(TRACER_NAME, TRACER_VERSION);
    tracker = new SpanTracker({
      tracer,
      captureContent: cfg.captureContent,
      cwd: cfg.cwd,
      sessionId: () => sessionIdRef,
    });
    pi.events.emit("pi-otel:status", { state: "ready", endpoint: cfg.endpoint });
  });

  // TODO(SPEC §9 q1): inject TRACEPARENT into bash subprocesses once pi
  // exposes a subprocess-env hook for the bash tool.
  // TODO(SPEC §7 P3): redaction + truncation for captureContent != "full".

}
