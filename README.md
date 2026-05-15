# pi-otel

OpenTelemetry tracing for [pi](https://github.com/earendil-works/pi-coding-agent). One trace tree per user prompt, exported to a local [.NET Aspire dashboard](https://aspire.dev/dashboard/standalone/) by default. Full OTel GenAI semantic-convention coverage (`gen_ai.*`) for token usage, cost, model, finish reasons, and tool calls. Pi has rich lifecycle events but no built-in timeline view — pi-otel is the "press one button, see your agent" surface.

## Install

```
pi install npm:pi-otel
```

(Package name placeholder — final name TBD. See `_plans/SPEC.md` §4 for prior art on npm.)

## Quickstart

```
/otel start         # spawn local Aspire dashboard
# ... run a prompt in pi ...
# open http://localhost:18888 in your browser
/otel stop          # when done
```

Driver auto-detect: Aspire CLI first, then Docker / Podman. Install one:

- Aspire CLI: `irm https://aspire.dev/install.ps1 | iex` (Windows) or `curl -sSL https://aspire.dev/install.sh | bash` (mac/linux)
- Docker or Podman

## Configuration

`.pi/settings.json` (project) or `~/.pi/agent/settings.json` (global):

```jsonc
{
  "otel": {
    "enabled": true,
    "endpoint": "http://localhost:4317",
    "protocol": "grpc",
    "headers": {},
    "serviceName": "pi",
    "captureContent": false,
    "sampleRatio": 1.0,
    "signals": { "traces": true, "metrics": false, "logs": false }
  }
}
```

| Key               | Description                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------ |
| `enabled`         | Master switch. `false` makes the extension a no-op.                                                    |
| `endpoint`        | OTLP receiver URL. Default targets local Aspire on gRPC 4317.                                          |
| `protocol`        | `grpc` (port 4317) or `http/protobuf` (port 4318).                                                     |
| `headers`         | Map of OTLP headers — auth tokens for cloud backends.                                                  |
| `serviceName`     | `service.name` resource attribute. Default `pi`.                                                       |
| `captureContent`  | When `true`, attach user prompts, LLM messages, and tool I/O to spans (capped at 60 KB per attribute). |
| `sampleRatio`     | `0.0`–`1.0`. Probabilistic span sampling.                                                              |
| `signals.traces`  | Emit trace spans. v0.1 only signal that ships.                                                         |
| `signals.metrics` | P2 — token / cost / latency histograms. Off in v0.1.                                                   |
| `signals.logs`    | P2 — transcript events as OTel logs. Off in v0.1.                                                      |

Standard `OTEL_*` env vars override settings. Pi-specific overrides: `PI_OTEL_CAPTURE_CONTENT`, `PI_OTEL_DISABLED`, `PI_OTEL_DEBUG`. See the skill for the full list.

### Logs signal

When `signals.logs: true`, pi-otel exports **lifecycle LogRecords** via OTLP:

- `pi.session.start` / `pi.session.end` (INFO)
- `pi.tool.error` / `pi.llm_request.error` (ERROR)

GenAI message content and per-tool execution data stay on spans (events plus the `gen_ai.input.messages` / `gen_ai.output.messages` attributes on `pi.llm_request`).

`@opentelemetry/*` SDK internal diag chatter (HostDetector, OTLPExportDelegate, etc.) is **not** exported — it's too noisy for Aspire Structured Logs. For local debugging set `PI_OTEL_DEBUG=1` to route diag output to the console via `DiagConsoleLogger`; `OTEL_LOG_LEVEL` (or `otel.logLevel`) controls its severity floor (default `DEBUG`).

```sh
PI_OTEL_DEBUG=1 OTEL_LOG_LEVEL=warn pi
```
