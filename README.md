# pi-otel

[![Docs](https://img.shields.io/badge/docs-pi--otel-blue)](https://nikiforovall.blog/pi-otel/)

OpenTelemetry tracing for [pi](https://github.com/earendil-works/pi-coding-agent). One trace tree per user prompt, exported to a local [.NET Aspire dashboard](https://aspire.dev/dashboard/standalone/) by default. Full OTel GenAI semantic-convention coverage (`gen_ai.*`) for token usage, cost, model, finish reasons, and tool calls. Pi has rich lifecycle events but no built-in timeline view — pi-otel is the "press one button, see your agent" surface.

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
    "captureContent": "metadata_only",
    "sampleRatio": 1.0,
    "signals": { "traces": true, "metrics": false, "logs": false }
  }
}
```

Key env var overrides: `OTEL_EXPORTER_OTLP_ENDPOINT`, `PI_OTEL_METRICS=1`, `PI_OTEL_LOGS=1`, `PI_OTEL_DISABLED=1`.

Full reference — settings, env vars, content capture modes, sampling, logs signal, and extensibility: [nikiforovall.blog/pi-otel/configuration](https://nikiforovall.blog/pi-otel/configuration)
