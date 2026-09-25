import type { ReactNode } from "react";

import { FieldDescription } from "../ui/field.js";

/** a note below a disclosure or dialog section, not tied to one control */
export function HelpText({ children }: { children: ReactNode }) {
  return <FieldDescription>{children}</FieldDescription>;
}
