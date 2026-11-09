import type { ProviderEventEvidence, ReadConnectionAttemptInput } from "../../db/types.js";

export interface LinearConnectionRecord {
  id: string;
  organizationId: string;
  slug: string;
  providerApplicationId: string | null;
  linearOrganizationId: string;
  linearOrganizationName: string;
  appUserId: string;
  accessToken: string;
  refreshToken: string | null;
  accessTokenExpiresAt: Date | null;
  scopes: string[];
}

export interface BindLinearConnectionInput extends ReadConnectionAttemptInput {
  providerApplicationId: string;
  linearOrganizationId: string;
  linearOrganizationName: string;
  appUserId: string;
  accessToken: string;
  refreshToken?: string | null;
  accessTokenExpiresAt?: Date | null;
  scopes: string[];
}

export interface CompleteLinearProviderApplicationInput extends BindLinearConnectionInput {
  providerConfiguration: {
    configuration: unknown;
    identity: { id: string };
    expectedVersion: number | undefined;
    updatedByUserId: string;
  };
}

export interface UpdateLinearConnectionTokensInput {
  connectionId: string;
  accessToken: string;
  refreshToken?: string | null;
  accessTokenExpiresAt?: Date | null;
  scopes?: string[];
}

export type LinearConnectionTokenUpdate = Omit<UpdateLinearConnectionTokensInput, "connectionId">;

export type LinearConnectionRefreshOperation<T> = (
  connection: LinearConnectionRecord | undefined,
  updateTokens: (input: LinearConnectionTokenUpdate) => Promise<void>,
) => Promise<T>;

export interface AcceptLinearEventInput extends ProviderEventEvidence {
  linearOrganizationId: string;
  projectId?: string;
}
