# Backends

pi-otel is built on [OpenTelemetry](https://opentelemetry.io/) and exports via OTLP — the vendor-neutral wire protocol supported by every major observability platform. Point it at any OTLP-compatible receiver by setting `endpoint` and optionally `protocol` and `headers`.

## Aspire Dashboard (default)

The [.NET Aspire standalone dashboard](https://aspire.dev/dashboard/standalone/) is the zero-config default — an in-memory OTLP receiver with a UI for traces, metrics, and structured logs. No account, no cloud required.

**Start from pi:**

```
/otel start
```

Backend auto-detection: Aspire CLI → Docker → Podman. Force one with `--driver=`:

```
/otel start --driver=docker
```

**Ports:**

| Signal | Endpoint |
| --- | --- |
| OTLP gRPC | `http://localhost:4317` |
| OTLP HTTP | `http://localhost:4318` |
| Dashboard UI | `http://localhost:18888` |

Telemetry is in-memory only — restarting the dashboard clears all data. See [`samples/aspire/`](https://github.com/NikiforovAll/pi-otel/tree/main/samples/aspire) for a minimal `.pi/settings.json`.

**Traces:**

![Traces in Aspire](https://raw.githubusercontent.com/NikiforovAll/pi-otel/master/samples/aspire/assets/aspire-traces.png)

**Metrics:**

![Metrics in Aspire](https://raw.githubusercontent.com/NikiforovAll/pi-otel/master/samples/aspire/assets/aspire-metrics.png)

**Logs:**

![Logs in Aspire](https://raw.githubusercontent.com/NikiforovAll/pi-otel/master/samples/aspire/assets/aspire-logs.png)

## Grafana LGTM

[otel-lgtm](https://github.com/grafana/otel-lgtm) is a single Docker image that bundles Grafana, Tempo (traces), Mimir (metrics), and Loki (logs) — pre-wired with an OpenTelemetry Collector.

**Start the stack:**

```bash
docker compose up   # or: podman compose up
```

See [`samples/lgtm/compose.yaml`](https://github.com/NikiforovAll/pi-otel/tree/main/samples/lgtm) for the full Compose file.

**Connect pi-otel:**

```
/otel connect http://localhost:4317
```

**Ports:**

| Signal | Endpoint |
| --- | --- |
| OTLP gRPC | `http://localhost:4317` |
| OTLP HTTP | `http://localhost:4318` |
| Grafana UI | `http://localhost:3000` |

The sample ships a pre-built Grafana dashboard (`dashboard.json`) with 8 panels: request rate, average duration, token usage by type, total tokens, tool calls per operation, p50/p95/p99 latency percentiles, and duration by model. Import it via Grafana → Dashboards → Import.

**Traces in Tempo:**

![Traces in Tempo](https://raw.githubusercontent.com/NikiforovAll/pi-otel/master/samples/lgtm/assets/traces-tempo.png)

**Metrics in Grafana:**

![Metrics in Grafana](https://raw.githubusercontent.com/NikiforovAll/pi-otel/master/samples/lgtm/assets/grafana-metrics.png)

**Logs in Loki:**

![Logs in Loki](https://raw.githubusercontent.com/NikiforovAll/pi-otel/master/samples/lgtm/assets/loki-logs.png)

## Other backends

Any OTLP-compatible receiver works. Set `endpoint` and (for authenticated cloud services) `headers`:

```jsonc
// .pi/settings.json
{
  "otel": {
    "endpoint": "https://api.honeycomb.io",
    "protocol": "http/protobuf",
    "headers": {
      "x-honeycomb-team": "<your-api-key>"
    }
  }
}
```

Or via env vars for ephemeral sessions:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://... \
OTEL_EXPORTER_OTLP_HEADERS="x-honeycomb-team=<key>" \
pi
```

Common OTLP targets: **Grafana Cloud**, **Honeycomb**, **Jaeger** (with OTLP receiver enabled), **Tempo**, **Datadog** (via the OTel Collector), or any self-hosted Collector.
