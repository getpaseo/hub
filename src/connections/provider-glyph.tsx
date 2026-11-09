import { TerminalIcon, ClockIcon } from "lucide-react";
import { browserProvider } from "../providers/browser.js";

export function ProviderGlyph({ provider }: { provider: string }) {
  if (provider === "manual") return <TerminalIcon className="size-4.5" aria-hidden="true" />;
  if (provider === "schedule") return <ClockIcon className="size-4.5" aria-hidden="true" />;
  const { glyph } = browserProvider(provider);
  return (
    <svg viewBox={glyph.viewBox} className="size-4.5" fill="currentColor" aria-hidden="true">
      {glyph.paths.map((path) => (
        <path key={path} d={path} />
      ))}
    </svg>
  );
}
