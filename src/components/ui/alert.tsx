import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../../lib/utils.js";

const alertVariants = cva("flex w-full items-start gap-3 rounded-lg border px-4 py-3 text-sm", {
  variants: {
    variant: {
      default:
        "bg-card text-card-foreground [&_[data-slot=alert-description]]:text-muted-foreground",
      destructive: "bg-card text-destructive [&_[data-slot=alert-description]]:text-destructive/90",
      success: "bg-card text-success [&_[data-slot=alert-description]]:text-success/90",
      warning:
        "border-warning/40 bg-warning-surface text-warning [&_[data-slot=alert-description]]:text-warning/90",
    },
  },
  defaultVariants: {
    variant: "default",
  },
});

/**
 * One anatomy for every alert: a glyph, a title over its message, and — when there is one thing
 * to do about it — a control at the far edge, centred against the whole message. The alert owns
 * that assembly rather than each caller repeating it, because three callers repeating it is how
 * two of them ended up with different spacing between a title and the line under it.
 *
 * The rows are laid out with flex, not grid: an action spanning grid rows resolves against the
 * *explicit* grid, so it silently landed in the title's row and stretched it to button height.
 */
function Alert({
  className,
  variant,
  icon,
  title,
  action,
  children,
  ...props
}: React.ComponentProps<"div"> &
  VariantProps<typeof alertVariants> & {
    /** The tone's glyph. Sized and coloured here; callers pass the bare icon. */
    icon?: React.ReactNode;
    title?: React.ReactNode;
    /** The single control belonging to the alert, e.g. a link to the page that resolves it. */
    action?: React.ReactNode;
  }) {
  return (
    <div
      data-slot="alert"
      role="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    >
      {icon === undefined ? null : (
        <span
          aria-hidden="true"
          className="shrink-0 translate-y-0.5 [&>svg]:size-4 [&>svg]:text-current"
        >
          {icon}
        </span>
      )}
      <div className="grid min-w-0 flex-1 gap-0.5">
        {title === undefined ? null : <AlertTitle>{title}</AlertTitle>}
        {children === undefined ? null : <AlertDescription>{children}</AlertDescription>}
      </div>
      {action === undefined ? null : (
        <div data-slot="alert-action" className="shrink-0 self-center pl-3">
          {action}
        </div>
      )}
    </div>
  );
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="alert-title" className={cn("min-w-0", className)} {...props} />;
}

function AlertDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn("grid min-w-0 justify-items-start gap-2 text-current", className)}
      {...props}
    />
  );
}

export { Alert };
