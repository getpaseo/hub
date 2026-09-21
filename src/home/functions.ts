import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { respondOk, type Result } from "../contract/respond.js";
import { respondWithFailure } from "../failures/index.js";
import { getApplication } from "../server/runtime.js";
import type { HomeSnapshot } from "./dashboard.js";

export type { HomeSnapshot } from "./dashboard.js";

const scopeSchema = z.object({ organizationSlug: z.string().trim().min(1).max(100) });

export const homeSnapshot = createServerFn({ method: "GET" })
  .validator(scopeSchema)
  .handler(async ({ data }): Promise<Result<HomeSnapshot>> => {
    try {
      const dashboard = (await getApplication()).homeDashboard;
      if (dashboard == null) throw new Error("home dashboard unavailable");
      return respondOk(await dashboard.snapshot(getRequest(), data.organizationSlug));
    } catch (error) {
      return respondWithFailure(
        error,
        { operation: "home.snapshot", component: "home", organizationSlug: data.organizationSlug },
        { fallback: "Hub couldn't load this organization's overview. Reload the page." },
      );
    }
  });
