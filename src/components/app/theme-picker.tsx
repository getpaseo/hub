import { Monitor, Moon, Sun, SunMoon } from "lucide-react";
import { useCallback, type ReactNode } from "react";
import { useTheme } from "../../theme.js";
import { Button } from "../ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover.js";
import { SegmentedControl } from "./segmented-control.js";

const THEME_OPTIONS = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
];

export function ThemePicker({ children }: { children?: ReactNode }) {
  const { theme, setTheme } = useTheme();
  const change = useCallback(
    (value: string) => {
      if (value === "system" || value === "light" || value === "dark") setTheme(value);
    },
    [setTheme],
  );
  return (
    <Popover>
      <PopoverTrigger asChild>
        {children ?? (
          <Button variant="ghost" size="sm">
            <SunMoon aria-hidden="true" />
            Appearance
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-fit">
        <SegmentedControl
          label="Appearance"
          value={theme}
          options={THEME_OPTIONS}
          onChange={change}
        />
      </PopoverContent>
    </Popover>
  );
}
