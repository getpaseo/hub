import * as React from "react";

import { cn } from "../../lib/utils.js";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-8 w-full min-w-0 rounded-md border border-input bg-transparent px-2.5 text-sm transition-colors duration-150 selection:bg-primary selection:text-primary-foreground file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:text-foreground placeholder:text-extra-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        "aria-invalid:border-destructive",
        // The browser's own spinner arrows are the one piece of chrome the palette does not
        // reach: they are drawn by the platform, in the platform's greys, beside controls that
        // are otherwise identical. A number field is typed into, and `min`/`step` still hold.
        "[&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none [-moz-appearance:textfield]",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
