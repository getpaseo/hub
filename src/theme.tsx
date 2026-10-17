import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type Theme = "system" | "light" | "dark";
type ResolvedTheme = Exclude<Theme, "system">;

export const THEME_STORAGE_KEY = "paseo-hub-theme";
const SYSTEM_THEME_QUERY = "(prefers-color-scheme: dark)";

/** Run before the body is painted, even when the application has not hydrated yet. */
export const themeScript = `(() => {
  let theme = "system";
  try { theme = localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)}) ?? "system"; } catch {}
  const dark = theme === "dark" || (theme !== "light" && matchMedia(${JSON.stringify(SYSTEM_THEME_QUERY)}).matches);
  document.documentElement.classList.toggle("dark", dark);
})();`;

interface ThemeContextValue {
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function storedTheme(): Theme {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    if (value === "light" || value === "dark") return value;
  } catch {
    // A blocked storage area still allows a theme for this tab.
  }
  return "system";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  // Keep the server and first client render identical. The head script already set the palette.
  const [theme, setPreference] = useState<Theme | null>(null);
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>("light");
  const resolvedTheme: ResolvedTheme =
    theme === "dark" || (theme === "system" && systemTheme === "dark") ? "dark" : "light";

  useEffect(() => {
    const media = window.matchMedia(SYSTEM_THEME_QUERY);
    const updateSystem = () => setSystemTheme(media.matches ? "dark" : "light");
    const updateStorage = (event: StorageEvent) => {
      if (event.key === THEME_STORAGE_KEY || event.key === null) setPreference(storedTheme());
    };
    setPreference(storedTheme());
    updateSystem();
    media.addEventListener("change", updateSystem);
    window.addEventListener("storage", updateStorage);
    return () => {
      media.removeEventListener("change", updateSystem);
      window.removeEventListener("storage", updateStorage);
    };
  }, []);

  useEffect(() => {
    if (theme !== null) document.documentElement.classList.toggle("dark", resolvedTheme === "dark");
  }, [theme, resolvedTheme]);

  const setTheme = useCallback((next: Theme) => {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Keep the selection usable when persistence is unavailable.
    }
    setPreference(next);
  }, []);

  const value = useMemo(
    () => ({ theme: theme ?? "system", resolvedTheme, setTheme }),
    [theme, resolvedTheme, setTheme],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const theme = useContext(ThemeContext);
  if (theme === null) throw new Error("useTheme must be used within ThemeProvider");
  return theme;
}
