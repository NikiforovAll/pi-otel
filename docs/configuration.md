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
| `PI_OTEL_METRICS=1` | Enables the metrics signal |
| `PI_OTEL_LOGS=1` | Enables the logs signal |

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
