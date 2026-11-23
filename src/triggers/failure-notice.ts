import { decodeEntitlementDenialFailureReason } from "../entitlements/denial.js";
import type { Database } from "../db/types.js";

export function isExecutionLimitDenial(reason: string): boolean {
  const denial = decodeEntitlementDenialFailureReason(reason);
  return (
    denial?.entitlement === "executions.monthly" && denial.kind === "meter" && denial.limit !== null
  );
}

export function missingBillingUrl(): Promise<string> {
  throw new Error("billing URL unavailable");
}

export async function agentFailureNotice(
  reason: string,
  organizationId: string,
  billingUrlForOrganization: (organizationId: string) => Promise<string>,
  now = new Date(),
): Promise<string> {
  if (!isExecutionLimitDenial(reason)) return `Paseo agent failed: ${reason}`;
  const denial = decodeEntitlementDenialFailureReason(reason)!;
  const month = new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(now);
  const reset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const resetDay = new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(reset);
  const billingUrl = await billingUrlForOrganization(organizationId);
  return `This org has used its ${denial.limit} free runs for ${month}. Runs reset on ${resetDay}, or upgrade to Pro under Billing: ${billingUrl}`;
}

export async function organizationBillingUrl(
  database: Database,
  publicBaseUrl: string,
  organizationId: string,
): Promise<string> {
  const slug = await database.findOrganizationSlugById(organizationId);
  if (slug === undefined) throw new Error(`organization not found: ${organizationId}`);
  return new URL(`/o/${encodeURIComponent(slug)}/settings/billing`, publicBaseUrl).toString();
}
