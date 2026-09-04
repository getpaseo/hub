import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";

import { cn } from "../../lib/utils.js";

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm whitespace-nowrap transition-[color,background-color,border-color,filter] duration-150 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    // `size` is declared before `variant` so a variant's own box wins the merge. That is what
    // makes `link` inline no matter which size a caller passes.
    variants: {
      size: {
        default: "h-8 px-3 has-[>svg]:px-2.5",
        xs: "h-6 gap-1 px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1.5 px-2.5 text-xs has-[>svg]:px-2",
        lg: "h-10 px-4 has-[>svg]:px-3.5",
        icon: "size-8",
        "icon-xs": "size-6 [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-7",
        "icon-lg": "size-10",
      },
      variant: {
        // A hue lifts rather than fades: dropping the fill's alpha over a near-black page
        // desaturates it towards the background, which reads as the button going out rather
        // than answering the pointer.
        default: "bg-primary text-primary-foreground hover:brightness-115",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        outline: "border border-input bg-transparent hover:bg-accent hover:text-accent-foreground",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
        // Underlined at rest, not on hover. A link inside a paragraph has to be tellable from
        // the prose around it without relying on colour — the link hue against muted body text
        // is 1.7:1 — so the decoration carries it and the hover promotes the decoration instead.
        link: "h-auto gap-1 p-0 text-link underline decoration-extra-muted-foreground underline-offset-4 hover:decoration-current",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : "button";

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
