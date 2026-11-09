import { z } from "zod";
import type { ProviderRegistry } from "../providers/registry.js";
import type { ProviderEventSummary } from "../providers/presentation.js";
export type TriggerSummary = ProviderEventSummary;

const ManualTriggerPayloadSchema = z
  .object({ trigger: z.string().optional(), actor: z.string().optional() })
  .passthrough();
export function summarizeTrigger(
  source: string,
  payload: unknown,
  registry: ProviderRegistry,
): TriggerSummary {
  const provider = source.split(".")[0] ?? "";
  if (provider === "schedule")
    return { provider, headline: "Scheduled run", actor: null, externalUrl: null };
  if (provider === "manual") return summarizeManual(payload);
  return registry.require(provider).summarizeEvent(payload);
}

function summarizeManual(payload: unknown): TriggerSummary {
  const parsed = ManualTriggerPayloadSchema.safeParse(payload);
  const triggerName = parsed.success ? parsed.data.trigger : undefined;
  return {
    provider: "manual",
    headline: triggerName === undefined ? "Manual run" : `Manual run: ${triggerName}`,
    actor: parsed.success ? (parsed.data.actor ?? null) : null,
    externalUrl: null,
  };
}
