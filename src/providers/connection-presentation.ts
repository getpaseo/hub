import type { ConnectionReturnCopy } from "../connections/result-contract.js";
export interface ProviderConnectionStatus {
  status: "notConfigured" | "disconnected" | "connected" | "suspended" | "requiresReauthorization";
}
export interface ProviderConnectionRow {
  provider: string;
  id: string;
  name: string;
  externalId: string;
  status: string;
}
export interface ProviderConnectionPresentation {
  order: number;
  parseStatus(value: unknown): ProviderConnectionStatus;
  rows(value: unknown): readonly ProviderConnectionRow[];
  actionLabel?(status: ProviderConnectionStatus, rows: readonly ProviderConnectionRow[]): string;
  returns: Readonly<Record<string, (name: string) => ConnectionReturnCopy>>;
}
export function connected(name: string): ConnectionReturnCopy {
  return { tone: "success", message: `${name} connected.` };
}
export function disconnected(name: string): ConnectionReturnCopy {
  return { tone: "success", message: `${name} disconnected.` };
}
export function cancelled(
  action: "Installation" | "Authorization",
  name: string,
): ConnectionReturnCopy {
  return {
    tone: "success",
    message: `${action} cancelled at ${name}. Nothing changed. Start again when you're ready.`,
  };
}
export function failed(name: string, message: string): ConnectionReturnCopy {
  return { tone: "error", title: `${name} wasn't connected`, message };
}
