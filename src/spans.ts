/**
 * Span lifecycle tracker.
 *
 * Owns one `pi.interaction` root span per user prompt. Children:
 *   - `pi.llm_request` per provider request
 *   - `pi.tool.<name>` per tool invocation (parallel-safe via Map<toolCallId, …>)
 *
 * Active provider span is single-slot — pi serializes provider requests
 * per session, but parallel tool calls overlap, so tools key on toolCallId.
 */

import {
  type Context,
  context as otelContext,
  type Span,
  SpanKind,
  type SpanOptions,
  SpanStatusCode,
  type Tracer,
  trace,
} from "@opentelemetry/api";
import { type LogAttributes, SeverityNumber } from "@opentelemetry/api-logs";
import {
  ATTR_AGENT_NAME,
  ATTR_CONVERSATION_ID,
  ATTR_ERROR_TYPE,
  ATTR_GEN_AI_INPUT_MESSAGES,
  ATTR_GEN_AI_OUTPUT_MESSAGES,
  ATTR_INPUT_TOKENS,
  ATTR_OPERATION_NAME,
  ATTR_OUTPUT_TOKENS,
  ATTR_PI_CWD,
  ATTR_PI_SESSION_ID,
  ATTR_PI_TOOL_CALL_ID,
  ATTR_PI_TOOL_COUNT,
  ATTR_PI_TOOL_INPUT,
  ATTR_PI_TOOL_IS_ERROR,
  ATTR_PI_TOOL_NAME,
  ATTR_PI_TOOL_OUTPUT,
  ATTR_PI_TURN_COUNT,
  ATTR_PI_TURN_INDEX,
  ATTR_PI_USER_PROMPT,
  ATTR_PI_USER_PROMPT_LENGTH,
  ATTR_REQUEST_MODEL,
  ATTR_RESPONSE_MODEL,
  ATTR_SESSION_ID,
  ATTR_SYSTEM,
  ATTR_TOKEN_TYPE,
  ATTR_TOOL_CALL_ARGUMENTS,
  ATTR_TOOL_CALL_ID,
  ATTR_TOOL_CALL_RESULT,
  ATTR_TOOL_NAME,
  type ContentCapture,
  clampAttr,
  EVENT_GEN_AI_ASSISTANT_MESSAGE,
  EVENT_GEN_AI_CHOICE,
  EVENT_GEN_AI_TOOL_MESSAGE,
  EVENT_GEN_AI_USER_MESSAGE,
  GEN_AI_AGENT_NAME_PI,
  GEN_AI_SYSTEM_PI,
  OP_CHAT,
  OP_EXECUTE_TOOL,
  OP_INVOKE_AGENT,
  SPAN_INTERACTION,
  SPAN_LLM_REQUEST,
  SPAN_TURN,
  type SpanNaming,
  spanToolName,
} from "./attrs.js";
import { emitLifecycleLog } from "./otel/logs.js";
import {
  getDurationHistogram,
  getTokenHistogram,
  getToolCallsCounter,
  getToolCallsHistogram,
} from "./otel/metrics.js";

export interface SpanTrackerOpts {
  tracer: Tracer;
  captureContent: ContentCapture;
  sessionId: () => string | undefined;
  cwd: string;
  /** Defaults to "legacy" — existing dashboards key off the `pi.*` names. */
  spanNaming?: SpanNaming;
}

interface ToolSlot {
  span: Span;
  ctx: Context;
  name: string;
}

interface LlmSlot {
  span: Span;
  ctx: Context;
  startNs: bigint;
  requestModel?: string;
  responseModel?: string;
  inputTokens?: number;
  outputTokens?: number;
  toolCallCount?: number;
}

/**
 * Flatten pi AgentMessage `content` (string | content-part[]) into a single
 * text string. Non-text parts are skipped — tool_calls are surfaced via
 * extractToolCalls instead.
 */
function extractMessageText(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const p of content as any[]) {
    if (!p || typeof p !== "object") continue;
    if (p.type === "text" && typeof p.text === "string") parts.push(p.text);
  }
  return parts.join("\n");
}

/**
 * Extract assistant tool_calls from AgentMessage content parts into the
 * OTel GenAI semconv shape: [{id, type:"function", function:{name, arguments}}].
 * `includeArguments=false` (no_tool_content) omits the arguments payload.
 */
function extractToolCalls(
  content: unknown,
  includeArguments: boolean,
): Array<Record<string, unknown>> {
  if (!Array.isArray(content)) return [];
  const calls: Array<Record<string, unknown>> = [];
  for (const p of content as any[]) {
    if (!p || typeof p !== "object") continue;
    const isToolCall =
      p.type === "toolCall" || p.type === "tool_call" || p.type === "tool_use";
    if (!isToolCall) continue;
    const id = p.id ?? p.toolCallId ?? p.tool_call_id ?? p.toolUseId;
    const name = p.name ?? p.toolName ?? p.tool_name;
    const args = p.arguments ?? p.input ?? p.args;
    const fn: Record<string, unknown> = { name };
    if (includeArguments && args !== undefined) {
      fn.arguments = typeof args === "string" ? args : JSON.stringify(args);
    }
    calls.push({ id, type: "function", function: fn });
  }
  return calls;
}

type PendingMsg =
  | { kind: "user"; content: string }
  | { kind: "tool"; content: string; toolCallId: string; toolName?: string };

export class SpanTracker {
  private opts: SpanTrackerOpts;
  private interaction: { span: Span; ctx: Context } | null = null;
  private turn: { span: Span; ctx: Context; index: number } | null = null;
  private llm: LlmSlot | null = null;
  private tools = new Map<string, ToolSlot>();
  private turnCount = 0;
  private toolCount = 0;
  // user/toolResult messages can land before the next llm_request opens; buffer
  // them and flush as gen_ai.*.message events when the LLM span starts.
  private pendingMessages: PendingMsg[] = [];

  constructor(opts: SpanTrackerOpts) {
    this.opts = opts;
  }

  private get genai(): boolean {
    return this.opts.spanNaming === "genai";
  }

  /**
   * Span name + kind for one operation. In legacy mode the kind is left unset
   * (SDK default INTERNAL) so the emitted span is byte-identical to pre-flag
   * output.
   */
  private spanOpts(
    legacyName: string,
    genaiName: string,
    kind: SpanKind,
    attrs: Record<string, string | number | boolean>,
    operation: string,
  ): [string, SpanOptions] {
    if (!this.genai) return [legacyName, { attributes: attrs }];
    attrs[ATTR_OPERATION_NAME] = operation;
    return [genaiName, { attributes: attrs, kind }];
  }

  private commonAttrs(): Record<string, string | number | boolean> {
    const sid = this.opts.sessionId();
    const attrs: Record<string, string | number | boolean> = {
      [ATTR_SYSTEM]: GEN_AI_SYSTEM_PI,
      [ATTR_PI_CWD]: this.opts.cwd,
    };
    if (sid) {
      attrs[ATTR_PI_SESSION_ID] = sid;
      attrs[ATTR_SESSION_ID] = sid;
      attrs[ATTR_CONVERSATION_ID] = sid;
    }
    return attrs;
  }

  startInteraction(prompt: string | undefined): void {
    if (this.interaction) return; // already open — defensive
    this.turnCount = 0;
    this.toolCount = 0;
    const attrs = this.commonAttrs();
    if (typeof prompt === "string") {
      attrs[ATTR_PI_USER_PROMPT_LENGTH] = prompt.length;
      if (this.opts.captureContent === "full") {
        attrs[ATTR_PI_USER_PROMPT] = clampAttr(prompt);
      }
    }
    if (this.genai) attrs[ATTR_AGENT_NAME] = GEN_AI_AGENT_NAME_PI;
    const span = this.opts.tracer.startSpan(
      ...this.spanOpts(
        SPAN_INTERACTION,
        `${OP_INVOKE_AGENT} ${GEN_AI_AGENT_NAME_PI}`,
        SpanKind.INTERNAL,
        attrs,
        OP_INVOKE_AGENT,
      ),
    );
    const ctx = trace.setSpan(otelContext.active(), span);
    this.interaction = { span, ctx };
  }

  endInteraction(error?: unknown): void {
    if (!this.interaction) return;
    const { span } = this.interaction;
    span.setAttribute(ATTR_PI_TURN_COUNT, this.turnCount);
    span.setAttribute(ATTR_PI_TOOL_COUNT, this.toolCount);
    if (error) {
      span.setAttribute(ATTR_ERROR_TYPE, (error as Error)?.name ?? "Error");
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: String((error as Error)?.message ?? error),
      });
    }
    // Close stragglers defensively.
    if (this.llm) {
      this.llm.span.end();
      this.llm = null;
    }
    for (const slot of this.tools.values()) slot.span.end();
    this.tools.clear();
    if (this.turn) {
      this.turn.span.end();
      this.turn = null;
    }
    span.end();
    this.interaction = null;
    this.pendingMessages = [];
  }

  startTurn(turnIndex: number | undefined): void {
    if (!this.interaction) return;
    if (this.turn) {
      // Defensive: a previous turn never closed — close it.
      this.turn.span.end();
      this.turn = null;
    }
    const idx = typeof turnIndex === "number" ? turnIndex : this.turnCount;
    const attrs = this.commonAttrs();
    attrs[ATTR_PI_TURN_INDEX] = idx;
    const span = this.opts.tracer.startSpan(
      SPAN_TURN,
      { attributes: attrs },
      this.interaction.ctx,
    );
    const ctx = trace.setSpan(this.interaction.ctx, span);
    this.turn = { span, ctx, index: idx };
    this.turnCount += 1;
  }

  endTurn(error?: unknown): void {
    if (!this.turn) return;
    if (error) {
      this.turn.span.setAttribute(
        ATTR_ERROR_TYPE,
        (error as Error)?.name ?? "Error",
      );
      this.turn.span.setStatus({
        code: SpanStatusCode.ERROR,
        message: String((error as Error)?.message ?? error),
      });
    }
    this.turn.span.end();
    this.turn = null;
  }

  startLlmRequest(model?: string): void {
    if (this.llm) {
      // Should not happen — defensive close.
      this.llm.span.end();
      this.llm = null;
    }
    const parentCtx =
      this.turn?.ctx ?? this.interaction?.ctx ?? otelContext.active();
    const attrs = this.commonAttrs();
    attrs[ATTR_OPERATION_NAME] = OP_CHAT;
    if (model) attrs[ATTR_REQUEST_MODEL] = model;
    const [name, spanOpts] = this.spanOpts(
      SPAN_LLM_REQUEST,
      model ? `${OP_CHAT} ${model}` : OP_CHAT,
      SpanKind.CLIENT,
      attrs,
      OP_CHAT,
    );
    const span = this.opts.tracer.startSpan(name, spanOpts, parentCtx);
    const ctx = trace.setSpan(parentCtx, span);
    this.llm = {
      span,
      ctx,
      startNs: process.hrtime.bigint(),
      requestModel: model,
    };
    this.currentInputMessages = [];
    this.flushPendingMessages();
  }

  // Accumulated input messages for the current LLM request, kept in the
  // GenAI semconv "messages" shape ({role, parts:[{type,...}]}) so we can
  // serialize to `gen_ai.input.messages` at the end. Aspire 9.x reads this
  // attribute, not the span events.
  private currentInputMessages: Array<Record<string, unknown>> = [];

  private flushPendingMessages(): void {
    if (!this.llm || this.pendingMessages.length === 0) return;
    if (this.opts.captureContent === "metadata_only") {
      this.pendingMessages = [];
      return;
    }
    const allowTool = this.opts.captureContent === "full";
    for (const m of this.pendingMessages) {
      if (m.kind === "user") {
        const attrs = {
          [ATTR_SYSTEM]: GEN_AI_SYSTEM_PI,
          role: "user",
          content: clampAttr(m.content),
        };
        this.llm.span.addEvent(EVENT_GEN_AI_USER_MESSAGE, attrs);
        this.currentInputMessages.push({
          role: "user",
          parts: [{ type: "text", content: m.content }],
        });
      } else if (m.kind === "tool" && allowTool) {
        const attrs = {
          [ATTR_SYSTEM]: GEN_AI_SYSTEM_PI,
          role: "tool",
          id: m.toolCallId,
          ...(m.toolName ? { name: m.toolName } : {}),
          content: clampAttr(m.content),
        };
        this.llm.span.addEvent(EVENT_GEN_AI_TOOL_MESSAGE, attrs);
        this.currentInputMessages.push({
          role: "tool",
          parts: [
            {
              type: "tool_call_response",
              id: m.toolCallId,
              ...(m.toolName ? { name: m.toolName } : {}),
              response: m.content,
            },
          ],
        });
      }
    }
    this.pendingMessages = [];
  }

  /**
   * Buffer a user-role message; flushed as a gen_ai.user.message event on the
   * next LLM span (or the current one if already open).
   */
  noteUserMessage(content: unknown): void {
    if (this.opts.captureContent === "metadata_only") return;
    const text = extractMessageText(content);
    if (!text) return;
    this.pendingMessages.push({ kind: "user", content: text });
    if (this.llm) this.flushPendingMessages();
  }

  /**
   * Buffer a toolResult message; flushed as a gen_ai.tool.message event on the
   * next LLM span (only when captureContent === "full").
   */
  noteToolResultMessage(msg: {
    toolCallId: string;
    toolName?: string;
    content: unknown;
  }): void {
    if (this.opts.captureContent !== "full") return;
    if (!msg.toolCallId) return;
    const text = extractMessageText(msg.content);
    this.pendingMessages.push({
      kind: "tool",
      content: text,
      toolCallId: msg.toolCallId,
      toolName: msg.toolName,
    });
    if (this.llm) this.flushPendingMessages();
  }

  /**
   * Emit gen_ai.assistant.message + gen_ai.choice events on the active LLM
   * span. Called from message_end before endLlmRequest.
   */
  noteAssistantMessage(message: any): void {
    if (!this.llm) return;
    if (typeof message?.model === "string")
      this.llm.responseModel = message.model;
    const allowTool = this.opts.captureContent === "full";
    const toolCalls = extractToolCalls(message?.content, allowTool);
    this.llm.toolCallCount = toolCalls.length;
    if (this.opts.captureContent === "metadata_only") return;
    const text = extractMessageText(message?.content);

    const assistantAttrs: Record<string, string | number | boolean> = {
      [ATTR_SYSTEM]: GEN_AI_SYSTEM_PI,
      role: "assistant",
    };
    if (text) assistantAttrs.content = clampAttr(text);
    if (toolCalls.length) assistantAttrs.tool_calls = clampAttr(toolCalls);
    this.llm.span.addEvent(EVENT_GEN_AI_ASSISTANT_MESSAGE, assistantAttrs);

    const finish =
      message?.stopReason ??
      message?.finishReason ??
      message?.finish_reason ??
      "stop";
    const choiceMessage: Record<string, unknown> = { role: "assistant" };
    if (text) choiceMessage.content = text;
    if (toolCalls.length) choiceMessage.tool_calls = toolCalls;
    const finishReasonStr = typeof finish === "string" ? finish : "stop";
    this.llm.span.addEvent(EVENT_GEN_AI_CHOICE, {
      [ATTR_SYSTEM]: GEN_AI_SYSTEM_PI,
      index: 0,
      finish_reason: finishReasonStr,
      message: clampAttr(choiceMessage),
    });

    // Aspire 9.x AI panel reads these JSON-stringified attributes on the
    // LLM span. The span events above are for older readers / log-pipeline
    // consumers — keep both.
    const outputParts: Array<Record<string, unknown>> = [];
    if (text) outputParts.push({ type: "text", content: text });
    if (allowTool) {
      for (const tc of toolCalls) {
        outputParts.push({
          type: "tool_call",
          id: tc.id,
          name: (tc.function as any)?.name,
          arguments: (tc.function as any)?.arguments,
        });
      }
    }
    const outputMessages = [
      { role: "assistant", parts: outputParts, finish_reason: finishReasonStr },
    ];

    if (this.currentInputMessages.length > 0) {
      this.llm.span.setAttribute(
        ATTR_GEN_AI_INPUT_MESSAGES,
        clampAttr(this.currentInputMessages),
      );
    }
    this.llm.span.setAttribute(
      ATTR_GEN_AI_OUTPUT_MESSAGES,
      clampAttr(outputMessages),
    );
  }

  setLlmAttrs(attrs: Record<string, unknown>): void {
    if (!this.llm) return;
    const respModel = attrs[ATTR_RESPONSE_MODEL];
    if (typeof respModel === "string") this.llm.responseModel = respModel;
    const reqModel = attrs[ATTR_REQUEST_MODEL];
    if (typeof reqModel === "string") this.llm.requestModel = reqModel;
    const inTok = attrs[ATTR_INPUT_TOKENS];
    if (typeof inTok === "number") this.llm.inputTokens = inTok;
    const outTok = attrs[ATTR_OUTPUT_TOKENS];
    if (typeof outTok === "number") this.llm.outputTokens = outTok;
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null) continue;
      // OTel SDK requires primitive or primitive[] values.
      if (
        typeof v === "string" ||
        typeof v === "number" ||
        typeof v === "boolean"
      ) {
        this.llm.span.setAttribute(k, v);
      } else if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
        this.llm.span.setAttribute(k, v);
      } else {
        this.llm.span.setAttribute(k, clampAttr(v));
      }
    }
  }

  endLlmRequest(error?: unknown): void {
    if (!this.llm) return;
    if (error) {
      const errName = (error as Error)?.name ?? "Error";
      const errMsg = String((error as Error)?.message ?? error);
      this.llm.span.setAttribute(ATTR_ERROR_TYPE, errName);
      this.llm.span.setStatus({ code: SpanStatusCode.ERROR, message: errMsg });
      const attrs: LogAttributes = {
        [ATTR_SYSTEM]: GEN_AI_SYSTEM_PI,
        [ATTR_ERROR_TYPE]: errName,
        "exception.message": errMsg,
      };
      if (this.llm.requestModel)
        attrs[ATTR_REQUEST_MODEL] = this.llm.requestModel;
      if (this.llm.responseModel)
        attrs[ATTR_RESPONSE_MODEL] = this.llm.responseModel;
      const stack = (error as Error)?.stack;
      if (typeof stack === "string") attrs["exception.stacktrace"] = stack;
      emitLifecycleLog(
        "pi.llm_request.error",
        SeverityNumber.ERROR,
        `LLM request failed: ${errMsg}`,
        attrs,
      );
    }
    this.recordLlmMetrics(error);
    this.llm.span.end();
    this.llm = null;
    this.currentInputMessages = [];
  }

  private recordLlmMetrics(error?: unknown): void {
    if (!this.llm) return;
    const elapsedSec = Number(process.hrtime.bigint() - this.llm.startNs) / 1e9;
    const baseAttrs: Record<string, string> = {
      [ATTR_SYSTEM]: GEN_AI_SYSTEM_PI,
      [ATTR_OPERATION_NAME]: "chat",
    };
    if (this.llm.requestModel)
      baseAttrs[ATTR_REQUEST_MODEL] = this.llm.requestModel;
    if (this.llm.responseModel)
      baseAttrs[ATTR_RESPONSE_MODEL] = this.llm.responseModel;
    if (error) baseAttrs[ATTR_ERROR_TYPE] = (error as Error)?.name ?? "Error";

    try {
      getDurationHistogram().record(elapsedSec, baseAttrs);
      if (typeof this.llm.inputTokens === "number") {
        getTokenHistogram().record(this.llm.inputTokens, {
          ...baseAttrs,
          [ATTR_TOKEN_TYPE]: "input",
        });
      }
      if (typeof this.llm.outputTokens === "number") {
        getTokenHistogram().record(this.llm.outputTokens, {
          ...baseAttrs,
          [ATTR_TOKEN_TYPE]: "output",
        });
      }
      getToolCallsHistogram().record(this.llm.toolCallCount ?? 0, baseAttrs);
    } catch {
      // Metrics are best-effort — never block span lifecycle.
    }
  }

  startTool(toolCallId: string, toolName: string, input: unknown): void {
    // Tool spans are siblings of pi.llm_request under pi.turn (SPEC §5).
    // Parenting under the LLM span would imply the tool ran *during* the model
    // call; tools actually execute after it.
    const parentCtx =
      this.turn?.ctx ?? this.interaction?.ctx ?? otelContext.active();
    const attrs = this.commonAttrs();
    attrs[ATTR_PI_TOOL_NAME] = toolName;
    attrs[ATTR_PI_TOOL_CALL_ID] = toolCallId;
    attrs[ATTR_TOOL_NAME] = toolName;
    attrs[ATTR_TOOL_CALL_ID] = toolCallId;
    if (this.opts.captureContent === "full" && input !== undefined) {
      const clamped = clampAttr(input);
      attrs[ATTR_PI_TOOL_INPUT] = clamped;
      attrs[ATTR_TOOL_CALL_ARGUMENTS] = clamped;
    }
    const [name, spanOpts] = this.spanOpts(
      spanToolName(toolName),
      `${OP_EXECUTE_TOOL} ${toolName}`,
      SpanKind.INTERNAL,
      attrs,
      OP_EXECUTE_TOOL,
    );
    const span = this.opts.tracer.startSpan(name, spanOpts, parentCtx);
    const ctx = trace.setSpan(parentCtx, span);
    this.tools.set(toolCallId, { span, ctx, name: toolName });
    this.toolCount += 1;
  }

  endTool(
    toolCallId: string,
    args: { isError?: boolean; result?: unknown },
  ): void {
    const slot = this.tools.get(toolCallId);
    if (!slot) return;
    if (args.isError) {
      slot.span.setAttribute(ATTR_PI_TOOL_IS_ERROR, true);
      slot.span.setStatus({ code: SpanStatusCode.ERROR });
      const attrs: LogAttributes = {
        [ATTR_SYSTEM]: GEN_AI_SYSTEM_PI,
        [ATTR_TOOL_NAME]: slot.name,
        [ATTR_TOOL_CALL_ID]: toolCallId,
      };
      if (this.opts.captureContent === "full" && args.result !== undefined) {
        attrs[ATTR_TOOL_CALL_RESULT] = clampAttr(args.result);
      }
      emitLifecycleLog(
        "pi.tool.error",
        SeverityNumber.ERROR,
        `tool ${slot.name} failed`,
        attrs,
      );
    } else {
      slot.span.setAttribute(ATTR_PI_TOOL_IS_ERROR, false);
    }
    if (this.opts.captureContent === "full" && args.result !== undefined) {
      const clamped = clampAttr(args.result);
      slot.span.setAttribute(ATTR_PI_TOOL_OUTPUT, clamped);
      slot.span.setAttribute(ATTR_TOOL_CALL_RESULT, clamped);
    }
    slot.span.end();
    this.tools.delete(toolCallId);
    try {
      const counterAttrs: Record<string, string> = {
        [ATTR_SYSTEM]: GEN_AI_SYSTEM_PI,
        [ATTR_TOOL_NAME]: slot.name,
      };
      if (args.isError) counterAttrs[ATTR_ERROR_TYPE] = "tool_error";
      getToolCallsCounter().add(1, counterAttrs);
    } catch {
      // Metrics are best-effort — never block lifecycle.
    }
  }

  /**
   * Drop any buffered user/tool messages — used when an interaction ends
   * without ever opening an LLM span (e.g., user prompt cancelled).
   */
  clearPending(): void {
    this.pendingMessages = [];
  }

  /**
   * Hook for the launcher / external code to read the active interaction
   * trace id (e.g. for surfacing in UI).
   */
  activeTraceId(): string | undefined {
    const sc = this.interaction?.span.spanContext();
    return sc?.traceId;
  }
}
