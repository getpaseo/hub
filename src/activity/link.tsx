/* oxlint-disable typescript-eslint/no-unsafe-type-assertion -- generated routes cannot express server-resolved organization URLs */
import { Link } from "@tanstack/react-router";
import type { ComponentProps } from "react";

import { activityLink } from "./query-contract.js";

/**
 * A link into Activity, filtered by `search` as Activity's own URL writes it. The one way a
 * screen outside Activity opens it on a trigger, daemon, provider, or view; wrap it in a
 * `Button` or menu item with `asChild` for that shape.
 */
export function ActivityLink({
  organizationSlug,
  search,
  ...anchor
}: {
  organizationSlug: string;
  search: Readonly<Record<string, unknown>>;
} & Omit<ComponentProps<"a">, "href">) {
  const link = activityLink(organizationSlug, search);
  // A menu item or button with `asChild` hands its own props through here onto the anchor.
  return <Link {...(anchor as object)} to={link.to as never} search={link.search as never} />;
}
