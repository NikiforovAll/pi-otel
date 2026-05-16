---
layout: home

hero:
  name: "pi-otel"
  text: "OpenTelemetry for the pi coding agent"
  tagline: One trace tree per prompt — interaction, turns, LLM requests, and tool calls — exported via OTLP.
  image:
    src: https://raw.githubusercontent.com/NikiforovAll/pi-otel/master/samples/lgtm/assets/grafana-metrics.png
    alt: Grafana metrics dashboard showing pi-otel data
  actions:
    - theme: brand
      text: Get Started
      link: /user-guide
    - theme: alt
      text: View on GitHub
      link: https://github.com/NikiforovAll/pi-otel
    - theme: alt
      text: Samples
      link: https://github.com/NikiforovAll/pi-otel/tree/main/samples

features:
  - title: Zero-config Aspire
    details: Run /otel start — pi-otel auto-detects Aspire CLI, Docker, or Podman and opens a local dashboard at http://localhost:18888. No YAML, no tokens.
  - title: Full span tree
    details: "pi.interaction → pi.turn* → pi.llm_request and pi.tool.<name>. Every user prompt gets its own root span; turns and tool calls nest naturally underneath."
  - title: GenAI semantic conventions
    details: Full gen_ai.* attribute coverage — token usage (input/output/cache), cost, model, finish reasons, tool call IDs, and conversation ID on every span.
  - title: Traces · Metrics · Logs
    details: All three OTel signals. Traces on by default. Enable metrics (duration/token/tool histograms) and logs (lifecycle records + SDK diag bridge) with a single env var.
  - title: Any OTLP backend
    details: Built on open standards — wire pi-otel to Grafana LGTM, Jaeger, Honeycomb, Grafana Cloud, or any OTLP-compatible receiver via endpoint + headers config.
  - title: Pi-native
    details: Ships as a pi package. pi install npm:pi-otel, then /otel start. No process to manage manually; the extension hooks into pi's own lifecycle events.
---
