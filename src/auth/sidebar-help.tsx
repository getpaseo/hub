import { CircleQuestionMark } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover.js";
import { SidebarMenuButton, SidebarMenuItem } from "../components/ui/sidebar.js";

const DISCORD_INVITE = "https://discord.gg/jz8T2uahpH";
const SUPPORT_EMAIL = "hello@paseo.sh";
const LINK = "underline underline-offset-4 hover:text-link";

/**
 * The two places a Hub user can reach a human. Kept as its own component because it is the only
 * part of Help worth reading twice: the popover around it is a Radix default.
 */
export function HelpChannels() {
  return (
    <div className="grid gap-2 text-sm">
      <p>
        Join the{" "}
        <a href={DISCORD_INVITE} target="_blank" rel="noreferrer" className={LINK}>
          Paseo Discord
        </a>{" "}
        and ask in #paseo-hub.
      </p>
      <p>
        Or email{" "}
        <a href={`mailto:${SUPPORT_EMAIL}`} className={LINK}>
          {SUPPORT_EMAIL}
        </a>
        .
      </p>
    </div>
  );
}

/**
 * Help sits in the sidebar footer rather than a page: it is asked from wherever you got stuck,
 * and a popover answers there instead of taking the destination away. It reads as a destination
 * (icon, label, tooltip when collapsed) so it needs no explaining next to the ones above it.
 */
export function SidebarHelp() {
  return (
    <SidebarMenuItem>
      <Popover>
        <PopoverTrigger asChild>
          <SidebarMenuButton
            size="sm"
            tooltip="Help"
            className="text-muted-foreground data-[state=open]:bg-sidebar-accent"
          >
            <CircleQuestionMark aria-hidden="true" />
            <span>Help</span>
          </SidebarMenuButton>
        </PopoverTrigger>
        <PopoverContent align="start" side="top" sideOffset={4} aria-label="Help" className="w-64">
          <HelpChannels />
        </PopoverContent>
      </Popover>
    </SidebarMenuItem>
  );
}
