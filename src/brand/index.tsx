import { cn } from "../lib/utils.js";
import {
  PASEO_HUB_LOCKUP_MARK_PATH,
  PASEO_HUB_LOCKUP_WORDMARK_PATH,
  PASEO_HUB_MARK_PATH,
} from "./paths.js";

/**
 * The standalone Paseo Hub flower mark. Sized to `size-7` by default so its 527-unit ink
 * footprint (~21px) sits cleanly on the sidebar background in both expanded and collapsed states.
 */
export function PaseoHubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 700 700" className={cn("size-7", className)} fill="none" aria-hidden="true">
      <path
        d={PASEO_HUB_MARK_PATH}
        stroke="currentColor"
        strokeWidth={50}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * The Paseo Hub horizontal lockup (flower mark + outlined Plus Jakarta Sans SemiBold wordmark),
 * for standalone and pre-auth surfaces.
 */
export function PaseoHubLockup({ className }: { className?: string }) {
  return (
    <svg
      role="img"
      aria-label="Paseo Hub"
      viewBox="0 0 842 144"
      className={cn("h-6 w-auto text-foreground", className)}
      fill="none"
    >
      <path
        d={PASEO_HUB_LOCKUP_MARK_PATH}
        stroke="currentColor"
        strokeWidth={13.28}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d={PASEO_HUB_LOCKUP_WORDMARK_PATH} fill="currentColor" />
    </svg>
  );
}
