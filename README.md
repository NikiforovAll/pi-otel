# pi-otel

[![npm version](https://img.shields.io/npm/v/pi-otel.svg)](https://www.npmjs.com/package/pi-otel)
[![npm downloads](https://img.shields.io/npm/dt/pi-otel.svg)](https://www.npmjs.com/package/pi-otel)
[![Docs](https://img.shields.io/badge/docs-pi--otel-blue)](https://nikiforovall.blog/pi-otel/)

OpenTelemetry tracing for [pi](https://github.com/earendil-works/pi-coding-agent) agent.

Full OTel GenAI semantic-convention coverage (`gen_ai.*`) for token usage, cost, model, finish reasons, and tool calls.

<table>
  <tr>
    <th align="center" colspan="3">Aspire dashboard</th>
  </tr>
  <tr>
    <td><img src="https://raw.githubusercontent.com/NikiforovAll/pi-otel/master/samples/aspire/assets/aspire-traces.png"/></td>
    <td><img src="https://raw.githubusercontent.com/NikiforovAll/pi-otel/master/samples/aspire/assets/aspire-metrics.png"/></td>
    <td><img src="https://raw.githubusercontent.com/NikiforovAll/pi-otel/master/samples/aspire/assets/aspire-logs.png"/></td>
  </tr>
  <tr>
    <th align="center" colspan="3">Grafana LGTM</th>
  </tr>
  <tr>
    <td><img src="https://raw.githubusercontent.com/NikiforovAll/pi-otel/master/samples/lgtm/assets/traces-tempo.png"/></td>
    <td><img src="https://raw.githubusercontent.com/NikiforovAll/pi-otel/master/samples/lgtm/assets/grafana-metrics.png"/></td>
    <td><img src="https://raw.githubusercontent.com/NikiforovAll/pi-otel/master/samples/lgtm/assets/loki-logs.png"/></td>
  </tr>
</table>

## Install

```
pi install npm:pi-otel
```

## Quickstart

```
/otel start         # spawn local Aspire dashboard
```

Backend auto-detect: Aspire CLI first, then Docker / Podman. Install one:

- Aspire CLI
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
    "captureContent": "metadata_only",
    "spanNaming": "legacy",
    "sampleRatio": 1.0,
    "signals": { "traces": true, "metrics": false, "logs": false }
  }
}
```

For the `http/protobuf` and `http/json` protocols, `endpoint` is the **base** URL — each signal appends its own resource path (`/v1/traces`, `/v1/metrics`, `/v1/logs`). For `grpc` the endpoint is used as-is.

`spanNaming: "genai"` (default `"legacy"`) renames spans to the OTel GenAI agent conventions — `invoke_agent pi` / `chat {model}` / `execute_tool {tool}` — and adds `gen_ai.operation.name` plus the spec SpanKind, so backends recognise pi as an agent. It also adds `gen_ai.agent.name` on the interaction span and, on `chat` spans only, `gen_ai.provider.name` (the request's inference provider, e.g. `openai`, `aws.bedrock`). No existing attribute is ever removed in either mode; `legacy` keeps the `pi.*` names existing dashboards query.

Key env var overrides: `OTEL_EXPORTER_OTLP_ENDPOINT`, `PI_OTEL_SPAN_NAMING=genai`, `PI_OTEL_METRICS=1`, `PI_OTEL_LOGS=1`, `PI_OTEL_DISABLED=1`.

Full reference — settings, env vars, content capture modes, sampling, logs signal, and extensibility: [nikiforovall.blog/pi-otel/configuration](https://nikiforovall.blog/pi-otel/configuration)
