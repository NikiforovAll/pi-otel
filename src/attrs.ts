/**
 * gen_ai.* attribute and metric constants.
 *
 * Names lifted verbatim from `@grafana/sigil-pi` v0.8.0
 * (`_audit/package/dist/index.js:24329-24363`) — Apache 2.0, attributed in NOTICE.
 * These are the canonical OTel GenAI semantic-convention attribute names.
 */

// Conversation / agent identity
export const ATTR_CONVERSATION_ID = "gen_ai.conversation.id";
export const ATTR_AGENT_NAME = "gen_ai.agent.name";
export const ATTR_AGENT_VERSION = "gen_ai.agent.version";
export const ATTR_USER_ID = "user.id";

// Errors
export const ATTR_ERROR_TYPE = "error.type";

// Operation / provider
export const ATTR_OPERATION_NAME = "gen_ai.operation.name";
export const ATTR_SYSTEM = "gen_ai.system";
export const ATTR_PROVIDER_NAME = "gen_ai.provider.name";

// Request
export const ATTR_REQUEST_MODEL = "gen_ai.request.model";
export const ATTR_REQUEST_MAX_TOKENS = "gen_ai.request.max_tokens";
export const ATTR_REQUEST_TEMPERATURE = "gen_ai.request.temperature";
export const ATTR_REQUEST_TOP_P = "gen_ai.request.top_p";

// Response
export const ATTR_RESPONSE_ID = "gen_ai.response.id";
export const ATTR_RESPONSE_MODEL = "gen_ai.response.model";
export const ATTR_FINISH_REASONS = "gen_ai.response.finish_reasons";

// Usage
export const ATTR_INPUT_TOKENS = "gen_ai.usage.input_tokens";
export const ATTR_OUTPUT_TOKENS = "gen_ai.usage.output_tokens";
export const ATTR_TOKEN_TYPE = "gen_ai.token.type";
export const ATTR_CACHE_READ_TOKENS = "gen_ai.usage.cache_read_input_tokens";
export const ATTR_CACHE_WRITE_TOKENS = "gen_ai.usage.cache_write_input_tokens";
export const ATTR_CACHE_CREATION_TOKENS = "gen_ai.usage.cache_creation_input_tokens";
export const ATTR_REASONING_TOKENS = "gen_ai.usage.reasoning_tokens";

// Tool
export const ATTR_TOOL_NAME = "gen_ai.tool.name";
export const ATTR_TOOL_CALL_ID = "gen_ai.tool.call.id";
export const ATTR_TOOL_TYPE = "gen_ai.tool.type";
export const ATTR_TOOL_DESCRIPTION = "gen_ai.tool.description";
export const ATTR_TOOL_CALL_ARGUMENTS = "gen_ai.tool.call.arguments";
export const ATTR_TOOL_CALL_RESULT = "gen_ai.tool.call.result";

// Pi-specific attributes (SPEC §5.4)
export const ATTR_PI_SESSION_ID = "pi.session.id";
export const ATTR_SESSION_ID = "session.id";
export const ATTR_PI_CWD = "pi.cwd";
export const ATTR_PI_TURN_COUNT = "pi.turn_count";
export const ATTR_PI_TURN_INDEX = "pi.turn_index";
export const ATTR_PI_TOOL_COUNT = "pi.tool_count";
export const ATTR_PI_TOOL_NAME = "pi.tool.name";
export const ATTR_PI_TOOL_CALL_ID = "pi.tool.call_id";
export const ATTR_PI_TOOL_IS_ERROR = "pi.tool.is_error";
export const ATTR_PI_TOOL_INPUT = "pi.tool.input";
export const ATTR_PI_TOOL_OUTPUT = "pi.tool.output";
export const ATTR_PI_COST_USD = "pi.cost.usd";
export const ATTR_PI_USER_PROMPT = "pi.user_prompt";
export const ATTR_PI_USER_PROMPT_LENGTH = "pi.user_prompt_length";

// HTTP
export const ATTR_HTTP_STATUS_CODE = "http.response.status_code";

// Span names
export const SPAN_INTERACTION = "pi.interaction";
export const SPAN_LLM_REQUEST = "pi.llm_request";
export const SPAN_TURN = "pi.turn";
export const spanToolName = (name: string) => `pi.tool.${name}`;

// Value used for ATTR_SYSTEM across this extension.
export const GEN_AI_SYSTEM_PI = "pi";

// captureContent trichotomy (lifted from sigil-pi audit)
export type ContentCapture = "metadata_only" | "no_tool_content" | "full";

/**
 * Truncate a string attribute to ~60 KB (Claude Code parity, SPEC §7).
 */
const MAX_ATTR_BYTES = 60 * 1024;
export function clampAttr(value: unknown): string {
  let s: string;
  if (typeof value === "string") s = value;
  else {
    try {
      s = JSON.stringify(value);
    } catch {
      s = String(value);
    }
  }
  if (Buffer.byteLength(s, "utf8") <= MAX_ATTR_BYTES) return s;
  // Byte-safe truncation: shrink until <= limit
  let end = MAX_ATTR_BYTES;
  while (Buffer.byteLength(s.slice(0, end), "utf8") > MAX_ATTR_BYTES - 32) end -= 64;
  return s.slice(0, end) + "…[truncated]";
}

/**
 * Pull token + cost data off a pi assistant message.usage object onto a span attributes record.
 * Tolerant of missing fields — pi providers differ in what they populate.
 */
export function applyUsageAttrs(
  attrs: Record<string, unknown>,
  usage: unknown,
): void {
  if (!usage || typeof usage !== "object") return;
  const u = usage as Record<string, any>;
  const set = (k: string, v: unknown) => {
    if (typeof v === "number" && Number.isFinite(v)) attrs[k] = v;
  };
  set(ATTR_INPUT_TOKENS, u.input ?? u.inputTokens ?? u.input_tokens);
  set(ATTR_OUTPUT_TOKENS, u.output ?? u.outputTokens ?? u.output_tokens);
  set(ATTR_CACHE_READ_TOKENS, u.cacheRead ?? u.cache_read ?? u.cacheReadTokens);
  set(
    ATTR_CACHE_WRITE_TOKENS,
    u.cacheWrite ?? u.cache_write ?? u.cacheWriteTokens,
  );
  set(
    ATTR_CACHE_CREATION_TOKENS,
    u.cacheCreation ?? u.cache_creation ?? u.cacheCreationTokens,
  );
  set(ATTR_REASONING_TOKENS, u.reasoning ?? u.reasoningTokens ?? u.reasoning_tokens);
  const cost = u.cost;
  if (cost && typeof cost === "object") {
    const total = (cost as any).total;
    if (typeof total === "number" && Number.isFinite(total)) {
      attrs[ATTR_PI_COST_USD] = total;
    }
  }
}
