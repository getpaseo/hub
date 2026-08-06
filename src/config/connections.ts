export interface ConnectionResolutionContext {
  executionId?: string;
  registerToken?: (token: string) => Promise<void> | void;
}

export type ConnectionResolver = (
  connectionSlug: string,
  value: string,
  context?: ConnectionResolutionContext,
) => Promise<string> | string;
