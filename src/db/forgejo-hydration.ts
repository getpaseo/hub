import type {
  ForgejoHydrationCursorKey,
  ForgejoHydrationStore,
} from "../triggers/forgejo/hydration-store.js";
import type { DatabaseRuntime, QueryHandle, QueryRow } from "./runtime/index.js";

export function createSqlForgejoHydrationStore(runtime: DatabaseRuntime): ForgejoHydrationStore {
  return {
    async getCursor(key) {
      const rows = await runtime.query<CursorRow>(
        `${CURSOR_SELECT}
         where connection_id = $1 and repository_id = $2 and subject_kind = $3
           and subject_id = $4 and record_kind = $5`,
        cursorParams(key),
      );
      const cursor = rows.rows[0]?.cursor_record_id;
      return cursor === undefined ? undefined : Number(cursor);
    },
    async seedCursor(key, cursorRecordId) {
      await runtime.query(
        `insert into forgejo_hydration_cursors (
           connection_id, repository_id, subject_kind, subject_id, record_kind,
           cursor_record_id, updated_at
         ) values ($1, $2, $3, $4, $5, $6, now())
         on conflict do nothing`,
        [...cursorParams(key), cursorRecordId],
      );
    },
    async insertRecoveredAndAdvance(input) {
      return runtime.transaction(async (transaction) => {
        await lockCursor(transaction, input.key);
        const inserted = await transaction.query(
          `insert into forgejo_hydrated_events (
             organization_id, connection_id, repository_id, subject_kind, subject_id,
             source_record_kind, source_record_id
           ) values ($1, $2, $3, $4, $5, $6, $7)
           on conflict (connection_id, repository_id, subject_kind, subject_id,
                        source_record_kind, source_record_id)
           do nothing
           returning id`,
          [
            input.organizationId,
            input.key.connectionId,
            input.key.repositoryId,
            input.key.subjectKind,
            input.key.subjectId,
            input.sourceRecordKind,
            input.sourceRecordId,
          ],
        );
        await transaction.query(
          `update forgejo_hydration_cursors
           set cursor_record_id = greatest(cursor_record_id, $6), updated_at = now()
           where connection_id = $1 and repository_id = $2 and subject_kind = $3
             and subject_id = $4 and record_kind = $5`,
          [...cursorParams(input.key), input.cursorRecordId],
        );
        return inserted.rows[0] === undefined ? "duplicate" : "inserted";
      });
    },
  };
}

const CURSOR_SELECT = `select cursor_record_id from forgejo_hydration_cursors`;

interface CursorRow extends QueryRow {
  cursor_record_id: number | string;
}

function cursorParams(key: ForgejoHydrationCursorKey): readonly unknown[] {
  return [key.connectionId, key.repositoryId, key.subjectKind, key.subjectId, key.recordKind];
}

async function lockCursor(transaction: QueryHandle, key: ForgejoHydrationCursorKey): Promise<void> {
  const existing = await transaction.query(
    `${CURSOR_SELECT}
     where connection_id = $1 and repository_id = $2 and subject_kind = $3
       and subject_id = $4 and record_kind = $5
     for update`,
    cursorParams(key),
  );
  if (existing.rows[0] !== undefined) return;
  await transaction.query(
    `insert into forgejo_hydration_cursors (
       connection_id, repository_id, subject_kind, subject_id, record_kind,
       cursor_record_id, updated_at
     ) values ($1, $2, $3, $4, $5, 0, now())
     on conflict do nothing`,
    cursorParams(key),
  );
  await transaction.query(
    `${CURSOR_SELECT}
     where connection_id = $1 and repository_id = $2 and subject_kind = $3
       and subject_id = $4 and record_kind = $5
     for update`,
    cursorParams(key),
  );
}
