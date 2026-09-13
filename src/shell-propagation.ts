/**
 * Opt-in W3C trace context propagation into the `bash` / `powershell` tools (#1).
 *
 * pi has no hook to mutate the child env of its built-in shell tools, so the
 * supported route is to rebuild the tool with `spawnHook` and re-register it
 * under the same name. pi warns once in interactive mode about the override;
 * that is why this is off by default (`propagateToShell`).
 */

import type {
  BashSpawnContext,
  createBashTool,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import * as piAgent from "@earendil-works/pi-coding-agent";
import { context as otelContext, propagation } from "@opentelemetry/api";
import type { SpanTracker } from "./spans.js";

type ShellToolFactory = typeof createBashTool;
export type ShellToolName = "bash" | "powershell";

// createPowerShellTool arrived after createBashTool; read both off the module
// namespace so pi versions without it still load and just skip that tool.
const SHELL_TOOLS: Record<ShellToolName, ShellToolFactory | undefined> = {
  bash: piAgent.createBashTool,
  powershell: (piAgent as Record<string, unknown>).createPowerShellTool as
    | ShellToolFactory
    | undefined,
};

/**
 * Inject `TRACEPARENT` / `TRACESTATE` from the active context into `env`.
 * Returns the same object untouched when no span is active.
 */
export function injectTraceContext(
  env: NodeJS.ProcessEnv,
  ctx = otelContext.active(),
): NodeJS.ProcessEnv {
  const carrier: Record<string, string> = {};
  propagation.inject(ctx, carrier);
  if (!carrier.traceparent) return env;
  const out: NodeJS.ProcessEnv = { ...env, TRACEPARENT: carrier.traceparent };
  if (carrier.tracestate) out.TRACESTATE = carrier.tracestate;
  return out;
}

export function registerShellPropagation(
  pi: ExtensionAPI,
  cwd: string,
  getTracker: () => SpanTracker | null,
): ShellToolName[] {
  const active = new Set(pi.getActiveTools());
  const overridden: ShellToolName[] = [];
  for (const name of Object.keys(SHELL_TOOLS) as ShellToolName[]) {
    const factory = SHELL_TOOLS[name];
    if (!factory || !active.has(name)) continue;
    const tool = factory(cwd, {
      spawnHook: (spawn: BashSpawnContext) => ({
        ...spawn,
        env: injectTraceContext(spawn.env),
      }),
    });
    pi.registerTool({
      ...tool,
      execute: (id, params, signal, onUpdate) => {
        const ctx = getTracker()?.toolContext(id) ?? otelContext.active();
        return otelContext.with(ctx, () =>
          tool.execute(id, params, signal, onUpdate),
        );
      },
    });
    overridden.push(name);
  }
  return overridden;
}
