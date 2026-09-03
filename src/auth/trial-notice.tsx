/* oxlint-disable typescript-eslint/no-unsafe-type-assertion -- the billing route is addressed by a server-resolved organization slug */
import { useCallback } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Clock } from "lucide-react";
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from "../components/ui/sidebar.js";
import { organizationTrial } from "../server/capabilities.js";

/** "12 days left in trial" — the entire reminder, and the reason a count of 1 is not "1 days". */
export function trialNoticeLabel(daysLeft: number): string {
  return `${daysLeft} ${daysLeft === 1 ? "day" : "days"} left in trial`;
}

/**
 * The sidebar's trial countdown. It renders only while a trial is actually running: the probe
 * answers null for a paid, free, cancelled, or self-hosted organization, so there is no billing
 * state for this to read and no way for it to invent a trial that does not exist. The reminder
 * leads to Billing, the only place the trial can be acted on.
 */
export function TrialNotice({ organizationSlug }: { organizationSlug: string }) {
  const load = useServerFn(organizationTrial);
  const trial = useQuery({
    queryKey: ["organization-trial", organizationSlug],
    queryFn: () => load({ data: { organizationSlug } }),
    staleTime: 5 * 60 * 1000,
  });
  const { isMobile, setOpenMobile } = useSidebar();
  // On compact the sidebar is an overlay covering the destination; client-side navigation has to
  // dismiss it the way the destinations above do.
  const navigate = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);
  const daysLeft = trial.data?.daysLeft ?? null;

  if (daysLeft === null) return null;
  const label = trialNoticeLabel(daysLeft);
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild size="sm" tooltip={label} className="text-muted-foreground">
        <Link to={`/o/${organizationSlug}/settings/billing` as never} onClick={navigate}>
          <Clock aria-hidden="true" />
          <span>{label}</span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
