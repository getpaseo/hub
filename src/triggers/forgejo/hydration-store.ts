export type ForgejoHydrationRecordKind = "timeline" | "review" | "review_comment";
export type ForgejoHydratedSourceRecordKind = "timeline" | "review" | "review_comment" | "label";

export interface ForgejoHydrationCursorKey {
  connectionId: string;
  repositoryId: number;
  subjectKind: "issue" | "pull_request";
  subjectId: number;
  recordKind: ForgejoHydrationRecordKind;
}

export interface ForgejoHydrationStore {
  getCursor(key: ForgejoHydrationCursorKey): Promise<number | undefined>;
  seedCursor(key: ForgejoHydrationCursorKey, cursorRecordId: number): Promise<void>;
  insertRecoveredAndAdvance(input: {
    key: ForgejoHydrationCursorKey;
    organizationId: string;
    sourceRecordKind: ForgejoHydratedSourceRecordKind;
    sourceRecordId: number;
    cursorRecordId: number;
  }): Promise<"inserted" | "duplicate">;
}
