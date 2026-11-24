import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { respondOk, type Result } from "../contract/respond.js";
import { respondWithFailure } from "../failures/index.js";
import { getApplication } from "../server/runtime.js";
import type { ActivityRecord, ActivitySnapshot } from "./dashboard.js";
import { activityQuery, parseActivitySearch } from "./query-contract.js";

export type {
  ActivityList,
  ActivityRecord,
  ActivityRunDetailView,
  ActivityRunView,
  ActivitySnapshot,
  ActivityStepView,
  UnmatchedEventDetailView,
  UnmatchedEventView,
} from "./dashboard.js";

const organizationSlug = z.string().trim().min(1).max(100);

const listSchema = z.object({
  organizationSlug,
  // The URL as the route holds it; the contract parses it on this side too, because the browser
  // is not the boundary.
  search: z
    .record(z.string(), z.unknown())
    .transform((raw) => activityQuery(parseActivitySearch(raw))),
});

const recordSchema = z.object({
  organizationSlug,
  kind: z.enum(["run", "unmatched"]),
  id: z.string().uuid(),
});

export const activitySnapshot = createServerFn({ method: "GET" })
  .validator(listSchema)
  .handler(async ({ data }): Promise<Result<ActivitySnapshot>> => {
    try {
      return respondOk(
        await (await dashboard()).snapshot(getRequest(), data.organizationSlug, data.search),
      );
    } catch (error) {
      return respondWithFailure(
        error,
        {
          operation: "activity.list",
          component: "activity",
          organizationSlug: data.organizationSlug,
        },
        { fallback: "Hub couldn't load this organization's activity. Reload the page." },
      );
    }
  });

export const activityRecord = createServerFn({ method: "GET" })
  .validator(recordSchema)
  .handler(async ({ data }): Promise<Result<ActivityRecord>> => {
    try {
      return respondOk(
        await (
          await dashboard()
        ).record(getRequest(), data.organizationSlug, {
          kind: data.kind,
          id: data.id,
        }),
      );
    } catch (error) {
      return respondWithFailure(
        error,
        {
          operation: "activity.record",
          component: "activity",
          organizationSlug: data.organizationSlug,
        },
        { fallback: "Hub couldn't load this record. Reload the page." },
      );
    }
  });

async function dashboard() {
  const activity = (await getApplication()).activityDashboard;
  if (activity == null) throw new Error("activity dashboard unavailable");
  return activity;
}
