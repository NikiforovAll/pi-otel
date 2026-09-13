# Configuration

pi-otel merges configuration from two files and environment variables. Project settings take precedence over global, env vars override both.

## Config files

| Path | Scope |
| --- | --- |
| `.pi/settings.json` | Project (checked in, per-repo) |
| `~/.pi/agent/settings.json` | Global (all sessions) |

Both use the same `"otel"` key:

```jsonc
{
  "otel": {
    "enabled": true,
    "endpoint": "http://localhost:4317",
    "protocol": "grpc",
    "headers": {},
    "serviceName": "pi",
    "captureContent": "metadata_only",
    "spanNaming": "legacy",
    "sampleRatio": 1.0,
    "signals": { "traces": true, "metrics": false, "logs": false }
  }
}
```

## Settings reference

| Key | Default | Description |
| --- | --- | --- |
| `enabled` | `true` | Master switch. `false` makes the extension a complete no-op. |
| `endpoint` | `http://localhost:4317` | OTLP receiver URL. Targets local Aspire on gRPC 4317 by default. For the `http/*` protocols this is the **base** URL — each signal appends its own path (`/v1/traces`, `/v1/metrics`, `/v1/logs`). For `grpc` it is used as-is. |
| `protocol` | `grpc` | `grpc` (port 4317), `http/protobuf` (port 4318), or `http/json` (port 4318). |
| `headers` | `{}` | Map of OTLP headers — use for auth tokens to cloud backends. |
| `serviceName` | `"pi"` | Value of the `service.name` resource attribute. |
| `captureContent` | `"metadata_only"` | Controls how much GenAI content lands on spans. See [Content capture](#content-capture). |
| `spanNaming` | `"legacy"` | `legacy` keeps the `pi.*` span names; `genai` emits OTel GenAI agent span names. See [Span naming](#span-naming). |
| `sampleRatio` | `1.0` | Probabilistic head sampling (`TraceIdRatioBased` wrapped in `ParentBased`). `1.0` = all spans; `0.1` = 10%. |
| `signals.traces` | `true` | Emit trace spans. |
| `signals.metrics` | `false` | Emit token / cost / latency histograms. Enable with `PI_OTEL_METRICS=1`. |
| `signals.logs` | `false` | Emit lifecycle LogRecords and bridge OTel SDK diag to OTLP. Enable with `PI_OTEL_LOGS=1`. |

## Standard OTEL_* env vars

| Env var | Overrides |
| --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `endpoint` |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `protocol` |
| `OTEL_EXPORTER_OTLP_HEADERS` | merged into `headers` |
| `OTEL_SERVICE_NAME` | `serviceName` |
| `OTEL_RESOURCE_ATTRIBUTES` | merged into resource attributes |
| `OTEL_LOG_LEVEL` | diag bridge severity floor (default `DEBUG`) |

## PI_OTEL_* overrides

| Env var | Effect |
| --- | --- |
| `PI_OTEL_DISABLED=1` | Disables the extension entirely |
| `PI_OTEL_CAPTURE_CONTENT` | `metadata_only` \| `no_tool_content` \| `full` |
| `PI_OTEL_SPAN_NAMING` | `legacy` \| `genai` |
| `PI_OTEL_METRICS=1` | Enables the metrics signal |
| `PI_OTEL_LOGS=1` | Enables the logs signal |

## Span naming

`spanNaming` selects how spans are named and classified. `genai` mode adds three things on top of `legacy`: `gen_ai.operation.name` on the interaction and tool spans, `gen_ai.agent.name` on the interaction span, and `gen_ai.provider.name` on the chat span when the inference provider is known — no existing attribute is ever removed, so both modes carry the same `gen_ai.*` and `pi.*` data plus these genai-only additions. `gen_ai.agent.name` is always the fixed literal `"pi"` — it identifies the agent, not the deployment, and is independent of the configurable `serviceName` (`service.name` resource attribute).

| Span | `legacy` (default) | `genai` |
| --- | --- | --- |
| Interaction | `pi.interaction`, kind unset (INTERNAL) | `invoke_agent pi`, `gen_ai.operation.name=invoke_agent`, `gen_ai.agent.name=pi`, kind `INTERNAL` |
| Turn | `pi.turn` | `pi.turn` (no spec equivalent — unchanged) |
| LLM request | `pi.llm_request`, `gen_ai.operation.name=chat` | `chat {gen_ai.request.model}`, kind `CLIENT`, `gen_ai.provider.name` (request's inference provider, when known) |
| Tool call | `pi.tool.{name}` | `execute_tool {gen_ai.tool.name}`, `gen_ai.operation.name=execute_tool`, kind `INTERNAL` |

Use `genai` when your backend (Logfire, Braintrust, Grafana GenAI panels) keys off `gen_ai.operation.name` to recognise agent traces. Keep `legacy` if you have dashboards or saved queries built on the `pi.*` span names — the bundled `samples/lgtm/dashboard.json` queries metrics only (`gen_ai_system` label), so it works in either mode; a custom saved query keyed on `pi.*` span names would still need `legacy`.

Names follow the [OTel GenAI agent span conventions](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md).

## Content capture

`captureContent` controls which GenAI content lands on spans:

| Value | What is captured |
| --- | --- |
| `"metadata_only"` (default) | Token counts, model, finish reasons, tool call IDs. No prompt or response text. |
| `"no_tool_content"` | Adds LLM message content (`gen_ai.input.messages`, `gen_ai.output.messages`). Tool input/output still omitted. |
| `"full"` | All content including tool inputs and outputs. Each attribute capped at 60 KB. |

`true` is accepted as an alias for `"full"`.

## Logs signal

When `signals.logs: true`, pi-otel exports **lifecycle LogRecords** via OTLP:

- `pi.session.start` / `pi.session.end` — INFO severity
- `pi.tool.error` / `pi.llm_request.error` — ERROR severity

OTel SDK internal diag chatter is bridged to the same OTLP endpoint under the `@opentelemetry/diag` instrumentation scope, with noisy per-export ticks filtered out. `OTEL_LOG_LEVEL` controls the severity floor.

pi-otel's own startup/failure messages surface via pi's native `ctx.ui.notify` — failing OTLP machinery cannot report its own failures through itself.

## Custom providers that skip `onPayload`

pi opens the `pi.llm_request` span on `before_provider_request`, which pi emits from `options.onPayload`. The pi custom-provider contract requires `streamSimple` implementations to call `onPayload`, but several extensions on npm do not (for example `@ssweens/pi-vertex`, `@sinamtz/pi-minimax-provider`, `@sinamtz/pi-mlx-provider`). With those, there is no LLM span and no token or cost data.

pi-otel falls back to the assistant `message_start` event, which pi emits on the stream `start` event for every provider. The span is opened there and closed on `message_end` as usual, so model, finish reason, tokens, and cost are all present. Two differences from the normal path:

- The span carries `pi.llm_request.synthesized=true`, and the `gen_ai.client.*` metrics carry the same attribute, so you can filter them out or compare.
- The span starts at stream start rather than at request send, so its duration is slightly shorter than the real request latency.

`gen_ai.provider.name` in genai mode and `pi.llm_request.error` logs work the same in both paths. The right long-term fix is for the provider to call `onPayload` and `onResponse`.

## Running alongside other OpenTelemetry extensions

Only one OpenTelemetry SDK can own the global tracer, meter, and logger providers in a process. If another extension (for example an OTel-based Langfuse or Logfire bridge) registers its providers before pi-otel starts, a second registration would not fail loudly: `@opentelemetry/api` logs a diag error, keeps the first provider, and every pi-otel span would silently route to the other SDK.

pi-otel checks for this before it starts. When it finds a provider it did not register, it shows one warning through `ctx.ui.notify` and stays disabled for that process:

```text
pi-otel: another OpenTelemetry SDK already registered global providers (trace); pi-otel telemetry is disabled for this process. Unload the other extension, or set PI_OTEL_DISABLED=1 to silence this.
```

The same check covers pi-otel loaded twice, for example from npm and from a git checkout in `packages`. There is no mode that attaches pi-otel exporters to a foreign SDK: the two extensions ship separate copies of the SDK classes, so a span processor from one cannot be installed on a provider from the other.
