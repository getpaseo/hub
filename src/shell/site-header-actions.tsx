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
 * Where a route's own controls land in the chrome, from `sm` up. A phone header holds the
 * sidebar trigger and the breadcrumb and nothing else: a mode switch and two buttons do not fit
 * beside them, and the slot that tried scrolled its own primary action off the right edge with
 * no sign it was there. Below `sm` this renders nothing, and the route puts the same controls in
 * the page — which is where a thumb reaches them anyway.
 */
export function SiteHeaderActionsTarget() {
  const target = useContext(SiteHeaderActionsContext);
  if (target === null) throw new Error("site header actions require their provider");
  return <div ref={target} className="ml-auto hidden shrink-0 items-center gap-2 sm:flex" />;
}

export function SiteHeaderActions({ children }: { children: ReactNode }) {
  const target = useContext(SiteHeaderActionsContext);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted && target?.current != null ? createPortal(children, target.current) : null;
}
