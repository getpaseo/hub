import { useCallback, useEffect, useState } from "react";

type TriggerStatusFilter = "all" | "enabled" | "disabled";

function readFilter(key: string): TriggerStatusFilter {
  try {
    const value = window.localStorage.getItem(key);
    if (value === "enabled" || value === "disabled") return value;
  } catch {
    // The control still works for this visit when browser storage is unavailable.
  }
  return "all";
}

export function useTriggerStatusFilter(organizationId: string) {
  const key = `paseo-hub-trigger-status:${organizationId}`;
  const [selection, setSelection] = useState<{
    key: string;
    value: TriggerStatusFilter;
  } | null>(null);

  useEffect(() => {
    const restore = () => setSelection({ key, value: readFilter(key) });
    const synchronize = (event: StorageEvent) => {
      if (event.key !== key && event.key !== null) return;
      try {
        if (event.storageArea !== window.localStorage) return;
      } catch {
        return;
      }
      restore();
    };
    restore();
    window.addEventListener("storage", synchronize);
    return () => window.removeEventListener("storage", synchronize);
  }, [key]);

  const setFilter = useCallback(
    (value: string) => {
      if (value !== "all" && value !== "enabled" && value !== "disabled") return;
      setSelection({ key, value });
      try {
        window.localStorage.setItem(key, value);
      } catch {
        // Persist only when the browser allows it; keep the current selection either way.
      }
    },
    [key],
  );

  const ready = selection?.key === key;
  return { filter: ready ? selection.value : "all", setFilter, ready };
}
