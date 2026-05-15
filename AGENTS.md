# AGENTS.md

`pi-otel` is a **pi extension** (loaded by `@earendil-works/pi-coding-agent`) that emits OpenTelemetry traces, metrics, and logs over OTLP. The default target is a local .NET Aspire dashboard. There is no runtime of its own — the entrypoint is a default-exported factory `(pi: ExtensionAPI) => void` that subscribes to pi lifecycle events.

## Commands

```bash
npm run build       # tsc → dist/
npm run dev         # tsc --watch
npm run typecheck   # tsc --noEmit (fast verify; preferred mid-edit)
npm run clean       # rm -rf dist
```

There is **no test suite, no linter, no formatter**. Verification = `npm run typecheck`. Behavioral checks happen by running pi against a live Aspire dashboard.

## Architecture

Trace tree, one per user prompt:

```
pi.interaction                      (root — before_agent_start / agent_end)
└── pi.turn*                        (one per turn_start / turn_end)
    ├── pi.llm_request              (before_provider_request / message_end)
    └── pi.tool.<toolName>          (tool_execution_start / _end; isError → ERROR status)
```

Session is **not** a span. It is `pi.session.id` / `session.id` / `gen_ai.conversation.id` attributes on every span. Rationale: a pi session can run for hours; long-running spans are an OTel anti-pattern.

### File map

- `src/index.ts` — pi event handlers (`session_start`, `before_agent_start`, `turn_start`/`turn_end`, `before_provider_request`, `message_start`/`_end`, `tool_execution_start`/`_end`, `agent_end`, `session_shutdown`). Wires events to `SpanTracker`. Holds the `notify` closure that routes pi-otel's own messages to `ctx.ui.notify`.
- `src/spans.ts` — `SpanTracker` owns the four span slots (`interaction`, `turn`, `llm`, `tools` Map). Parent context resolution: `turn?.ctx ?? interaction?.ctx ?? otelContext.active()`. Also buffers pending user/tool messages so they can be flushed as `gen_ai.user.message` / `gen_ai.tool.message` events on the next opened LLM span, and synthesizes `gen_ai.input.messages` / `gen_ai.output.messages` attributes (Aspire 9.x AI panel reads these JSON-stringified attrs).
- `src/attrs.ts` — every OTel attribute / span / metric name. **Names lifted verbatim from `@grafana/sigil-pi` v0.8.0** (Apache 2.0, audited in `_plans/AUDIT-sigil-pi.md`). Use these constants — do not hand-write `"gen_ai.*"` strings.
- `src/config.ts` — `resolveConfig(cwd)` merges `.pi/settings.json` + `~/.pi/agent/settings.json` + `OTEL_*` env vars + `PI_OTEL_*` overrides.
- `src/otel/sdk.ts` — global `NodeSDK` lifecycle (`initSdk`, `shutdownSdk`). One SDK per process; `initOnce` guards reinit. `shutdownSdk` calls `trace.disable()` + `diag.disable()` + resets metric/log handles before nulling, because the global API refuses to replace an already-registered provider — without this, a subsequent `initSdk` silently keeps the dead one.
- `src/otel/logs.ts` — LogRecord emitters. **Two loggers**: `pi-otel` for lifecycle records and `@opentelemetry/diag` for the diag bridge. The bridge is installed *after* `sdk.start()` (LoggerProvider must exist first) via `diag.setLogger`. `BRIDGE_DROP` regex filters per-export ticks. **pi-otel's own internal messages (SDK start/fail) go through `ctx.ui.notify` via the `notify` callback, NOT through `diag`** — failing OTLP machinery can't reliably report its own failures through itself.
- `src/otel/metrics.ts` — lazy-initialized histogram handles (`getDurationHistogram`, `getTokenHistogram`, `getToolCallsHistogram`). `resetMetricHandles()` runs on shutdown.
- `src/commands/otel.ts` — `/otel` slash command (Aspire dashboard launcher).

### Structured logging discipline

LogRecord `body` = human-readable string. Structured data goes in `attributes`. Do **not** JSON-blob into the body — Aspire renders body as the Message column. `emitLifecycleLog(eventName, severity, body, attrs)` enforces this; always include `event.name` (auto-added).

## Critical gotchas

- **Severity union excludes `"success"`.** pi's `ctx.ui.notify` accepts `"info" | "warning" | "error"`. The `NotifySeverity` type and `notify` wrapper in `src/index.ts` must match — do not add `"success"`.
- **Bridge installation order.** `diag.setLogger(buildBridgeDiagLogger(), …)` must happen *after* `sdk.start()`, otherwise there's no LoggerProvider to emit into. See `src/otel/sdk.ts` after the try/catch.
- **Tool span parent.** Tool spans hang off `pi.turn` (or `pi.interaction` when no turn is active), **never** off `pi.llm_request` — tools execute after the LLM call, not during it.
- **Pi peer dep.** `@earendil-works/pi-coding-agent` is a peer dep; the user installs pi-otel via `pi install npm:pi-otel` and pi loads `dist/index.js` per the `"pi": { "extensions": [...] }` block in `package.json`.
