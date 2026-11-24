import { describe, expect, it } from "vitest";
import {
  activityHref,
  activityQuery,
  hasFilters,
  parseActivitySearch,
  rangeStart,
  withFilters,
  withPage,
  withSelected,
  withSort,
  withView,
  withoutFilters,
} from "./query-contract.js";

const RUN = "5B0F6C1E-1111-4111-8111-111111111111";
const TRIGGER = "30000000-0000-4000-8000-000000000001";

describe("activity URL contract", () => {
  it("keeps what the view understands and drops the rest, so a stale link still opens", () => {
    expect(
      parseActivitySearch({
        view: "runs",
        range: "7d",
        provider: "slack,bogus,github,slack",
        trigger: TRIGGER,
        daemon: "not-a-uuid",
        status: "failed,rejected,exploded",
        reason: "no_project_route",
        q: "  deploy  ",
        sort: "received_at",
        dir: "up",
        page: "1",
        selected: RUN,
      }),
    ).toEqual({
      provider: "github,slack",
      trigger: TRIGGER,
      status: "failed,rejected",
      q: "deploy",
      selected: RUN.toLowerCase(),
    });
    expect(
      parseActivitySearch({
        view: "unmatched",
        trigger: TRIGGER,
        status: "failed",
        reason: "trigger_filters_rejected",
        sort: "duration",
        q: 404,
        page: 9999,
      }),
    ).toEqual({
      view: "unmatched",
      reason: "trigger_filters_rejected",
      q: "404",
      page: 9999,
    });
  });

  it("fills every default for the server", () => {
    expect(activityQuery({})).toEqual({
      view: "runs",
      range: "7d",
      providers: [],
      trigger: null,
      daemon: null,
      statuses: [],
      reason: null,
      q: null,
      sort: "received_at",
      dir: "desc",
      page: 1,
    });
    expect(
      activityQuery(parseActivitySearch({ status: "rejected,failed", page: "2" })),
    ).toMatchObject({ statuses: ["failed", "rejected"], page: 2 });
  });

  it("resets the page and the open record when the list underneath them changes", () => {
    const search = parseActivitySearch({ status: "failed", page: "3", selected: RUN });
    expect(withFilters(search, { q: "deploy" })).toEqual({ status: "failed", q: "deploy" });
    expect(withView(search, "unmatched")).toEqual({ view: "unmatched" });
    expect(withSort(search, "duration")).toEqual({
      status: "failed",
      sort: "duration",
      selected: RUN.toLowerCase(),
    });
    expect(withSort(withSort(search, "duration"), "duration")).toMatchObject({ dir: "asc" });
    expect(withSort({ sort: "duration", dir: "asc" }, "received_at")).toEqual({});
    expect(withPage(search, 4)).toMatchObject({ page: 4, selected: RUN.toLowerCase() });
    expect(withSelected(search, undefined)).toEqual({ status: "failed", page: 3 });
    expect(hasFilters(search)).toBe(true);
    expect(hasFilters({ range: "30d", page: 2 })).toBe(false);
    expect(
      withoutFilters({ view: "unmatched", range: "24h", reason: "no_project_route", q: "x" }),
    ).toEqual({ view: "unmatched", range: "24h" });
  });

  it("writes the same state as the same link", () => {
    expect(activityHref("acme")).toBe("/o/acme/activity");
    expect(
      activityHref("acme", { selected: RUN, status: "failed,timed_out,rejected", range: "24h" }),
    ).toBe(
      `/o/acme/activity?range=24h&status=failed%2Ctimed_out%2Crejected&selected=${RUN.toLowerCase()}`,
    );
    expect(activityHref("acme", { view: "unmatched", provider: "github" })).toBe(
      "/o/acme/activity?view=unmatched&provider=github",
    );
  });

  it("measures ranges back from now", () => {
    const now = new Date("2026-11-20T12:00:00Z");
    expect(rangeStart("24h", now)?.toISOString()).toBe("2026-11-19T12:00:00.000Z");
    expect(rangeStart("30d", now)?.toISOString()).toBe("2026-10-21T12:00:00.000Z");
    expect(rangeStart("all", now)).toBeNull();
  });
});
