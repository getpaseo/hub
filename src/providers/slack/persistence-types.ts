import type { ProviderEventEvidence, ReadConnectionAttemptInput } from "../../db/types.js";

export interface SlackConnectionRecord {
  id: string;
  organizationId: string;
  slug: string;
  teamId: string;
  teamName: string;
  botUserId: string;
  botAccessToken: string;
  scopes: string[];
  providerApplicationId: string | null;
}

export interface BindSlackConnectionInput extends ReadConnectionAttemptInput {
  providerApplicationId: string;
  teamId: string;
  teamName: string;
  botUserId: string;
  botAccessToken: string;
  scopes: string[];
}

export interface CompleteSlackProviderApplicationInput extends BindSlackConnectionInput {
  providerConfiguration: {
    configuration: unknown;
    identity: { id: string };
    expectedVersion: number | undefined;
    updatedByUserId: string;
  };
}

export interface AcceptSlackEventInput extends ProviderEventEvidence {
  teamId: string;
}
