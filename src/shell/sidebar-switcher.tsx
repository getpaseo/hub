import { ChevronsUpDown } from "lucide-react";
import type { ReactNode, RefObject } from "react";

import { cn } from "../lib/utils.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.js";
import { SidebarMenuButton } from "../components/ui/sidebar.js";

/**
 * The sidebar header row: a mark, where you are, and — when there is somewhere else to be — the
 * menu that takes you there. Organization, project, account, and instance are four levels of
 * the same question, so they are four uses of one row rather than four hand-styled ones that
 * drift a pixel apart every time somebody edits the sidebar.
 *
 * `lg` puts the mark in a square tile over two lines of label; `default` is one line with a
 * plain glyph, for a level that sits underneath another one already saying where you are.
 */
export interface SwitcherFace {
  /** A glyph or a pair of initials. The tile around it belongs to the row, not to the caller. */
  media: ReactNode;
  primary: string;
  secondary?: string;
  size?: "default" | "lg";
  /** `accent` is for the account, which is a person rather than a tenant. */
  tone?: "primary" | "accent";
}

export function SidebarSwitcher({
  label,
  media,
  primary,
  secondary,
  size = "lg",
  tone = "primary",
  side = "bottom",
  trigger,
  children,
}: SwitcherFace & {
  /** Names the level being switched, e.g. "Organization". */
  label: string;
  side?: "top" | "bottom";
  trigger?: RefObject<HTMLButtonElement | null>;
  /** The menu items. The menu itself, its width, and its offset belong to the row. */
  children: ReactNode;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarMenuButton
          {...(trigger === undefined ? {} : { ref: trigger })}
          size={size}
          aria-label={label}
          tooltip={primary}
          className="data-[state=open]:bg-sidebar-accent"
        >
          <Face
            media={media}
            primary={primary}
            size={size}
            tone={tone}
            {...(secondary === undefined ? {} : { secondary })}
          />
          <ChevronsUpDown aria-hidden="true" className="ml-auto size-4 text-muted-foreground" />
        </SidebarMenuButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side={side}
        sideOffset={4}
        className="w-(--radix-dropdown-menu-trigger-width) min-w-56"
      >
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The same row where there is nothing to switch to. The instance is the deployment: one of it,
 * always, so its header states where you are instead of offering a choice that has one option.
 */
export function SidebarIdentity({
  media,
  primary,
  secondary,
  size = "lg",
  tone = "primary",
}: SwitcherFace) {
  return (
    <div className="flex h-12 w-full items-center gap-2 overflow-hidden rounded-md px-2 text-left text-sm group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:p-0!">
      <Face
        media={media}
        primary={primary}
        size={size}
        tone={tone}
        {...(secondary === undefined ? {} : { secondary })}
      />
    </div>
  );
}

function Face({
  media,
  primary,
  secondary,
  size,
  tone,
}: Required<Pick<SwitcherFace, "media" | "size" | "tone">> & {
  primary: string;
  secondary?: string;
}) {
  return (
    <>
      {size === "lg" ? (
        <span
          className={cn(
            "flex aspect-square size-8 shrink-0 items-center justify-center rounded-md text-xs",
            tone === "primary" ? "bg-primary text-primary-foreground" : "bg-sidebar-accent",
          )}
        >
          {media}
        </span>
      ) : (
        media
      )}
      <span className="grid flex-1 text-left leading-tight group-data-[collapsible=icon]:hidden">
        <span className="truncate text-sm">{primary}</span>
        {secondary === undefined ? null : (
          <span className="truncate text-xs text-muted-foreground">{secondary}</span>
        )}
      </span>
    </>
  );
}
