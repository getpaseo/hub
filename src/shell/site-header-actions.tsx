import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

const SiteHeaderActionsContext = createContext<RefObject<HTMLDivElement | null> | null>(null);

export function SiteHeaderActionsProvider({ children }: { children: ReactNode }) {
  const target = useRef<HTMLDivElement>(null);
  return (
    <SiteHeaderActionsContext.Provider value={target}>{children}</SiteHeaderActionsContext.Provider>
  );
}

/**
 * Where a route's own controls land in the chrome. The slot shrinks and scrolls rather than
 * pushing the header wider than the window: a route that puts a mode switch and two buttons up
 * here does not fit a phone beside the breadcrumb, and a page that scrolls sideways as a whole
 * takes every other surface with it.
 */
export function SiteHeaderActionsTarget() {
  const target = useContext(SiteHeaderActionsContext);
  if (target === null) throw new Error("site header actions require their provider");
  return (
    <div
      ref={target}
      className="ml-auto flex min-w-0 shrink items-center gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    />
  );
}

export function SiteHeaderActions({ children }: { children: ReactNode }) {
  const target = useContext(SiteHeaderActionsContext);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted && target?.current != null ? createPortal(children, target.current) : null;
}
