import type { PromptPartialReadResult } from "../config/prompt-partials.js";
import type { ProjectConfigurationRevisionRecord } from "../db/types.js";

export interface ForgejoConfigurationProvider {
  listConnectionRepositories(input: {
    connectionId: string;
  }): Promise<Array<{ repositoryId: number; fullName: string; defaultBranch: string }>>;
  readDefaultBranchHead(input: {
    connectionId: string;
    repositoryId: number;
    defaultBranch: string;
  }): Promise<string>;
  listFilesAtCommit(input: {
    connectionId: string;
    repositoryId: number;
    commitSha: string;
    prefix: string;
  }): Promise<readonly { path: string; kind: PromptPartialReadResult["kind"] }[]>;
  readFileAtCommit(input: {
    connectionId: string;
    repositoryId: number;
    commitSha: string;
    path: string;
  }): Promise<PromptPartialReadResult | undefined>;
}

export type ForgejoConfigurationSyncResult =
  | { outcome: "activated"; revision: ProjectConfigurationRevisionRecord }
  | { outcome: "invalid"; revision: ProjectConfigurationRevisionRecord }
  | { outcome: "fetch_failed" };
