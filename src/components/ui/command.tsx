import * as React from "react";
import { Command as CommandPrimitive, defaultFilter } from "cmdk";
import { SearchIcon } from "lucide-react";

import { cn } from "../../lib/utils.js";

function Command({ className, ...props }: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      className={cn(
        "flex h-full w-full flex-col overflow-hidden rounded-lg bg-popover text-popover-foreground",
        className,
      )}
      {...props}
    />
  );
}

function CommandInput({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div data-slot="command-input-wrapper" className="flex h-9 items-center gap-2 border-b px-2.5">
      <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
      <CommandPrimitive.Input
        data-slot="command-input"
        className={cn(
          "flex h-8 w-full outline-none bg-transparent text-sm placeholder:text-extra-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...props}
      />
    </div>
  );
}

/**
 * The scrolling list of options. A fade covers whichever edge has options beyond it, and the
 * height stops partway through a row, so a list with more below never looks finished.
 */
function CommandList({
  className,
  ...props
}: Omit<React.ComponentProps<typeof CommandPrimitive.List>, "ref">) {
  const list = React.useRef<HTMLDivElement>(null);
  const overflow = useScrollOverflow(list);
  return (
    <div className="relative">
      <CommandPrimitive.List
        ref={list}
        data-slot="command-list"
        className={cn(
          // 14.5rem ends partway through a row, whether the options are one line or two.
          "max-h-58 scroll-py-1 overflow-x-hidden overflow-y-auto [scrollbar-color:var(--input)_transparent] [scrollbar-width:thin]",
          className,
        )}
        {...props}
      />
      {overflow.above ? <CommandListFade edge="top" /> : null}
      {overflow.below ? <CommandListFade edge="bottom" /> : null}
    </div>
  );
}

function CommandListFade({ edge }: { edge: "top" | "bottom" }) {
  return (
    <div
      aria-hidden="true"
      data-slot="command-list-fade"
      data-edge={edge}
      className={cn(
        "pointer-events-none absolute inset-x-0 h-8 from-popover to-transparent",
        edge === "top" ? "top-0 bg-linear-to-b" : "bottom-0 bg-linear-to-t",
      )}
    />
  );
}

interface ScrollOverflow {
  above: boolean;
  below: boolean;
}

const NO_OVERFLOW: ScrollOverflow = { above: false, below: false };

/**
 * Whether a scrolling element has content past its top or bottom edge. It is measured again on
 * scroll and whenever the element or its content changes size, which is how a search that
 * narrows the options is noticed.
 */
function useScrollOverflow(ref: React.RefObject<HTMLElement | null>): ScrollOverflow {
  const [overflow, setOverflow] = React.useState(NO_OVERFLOW);
  React.useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return undefined;
    const measure = () => {
      const above = element.scrollTop > 1;
      const below = element.scrollHeight - element.clientHeight - element.scrollTop > 1;
      setOverflow((current) =>
        current.above === above && current.below === below ? current : { above, below },
      );
    };
    measure();
    element.addEventListener("scroll", measure, { passive: true });
    const resize = new ResizeObserver(measure);
    resize.observe(element);
    for (const child of element.children) resize.observe(child);
    return () => {
      element.removeEventListener("scroll", measure);
      resize.disconnect();
    };
  }, [ref]);
  return overflow;
}

function CommandEmpty({ ...props }: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className="py-6 text-center text-sm"
      {...props}
    />
  );
}

function CommandItem({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        // A floor, not a fixed height: an option with a detail line under its label is two
        // lines tall, and a fixed height ran them into the option below.
        "relative flex min-h-8 cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm select-none data-[disabled=true]:pointer-events-none data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground data-[disabled=true]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export { Command, CommandInput, CommandList, CommandEmpty, CommandItem, defaultFilter };
