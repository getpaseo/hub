import { useEffect, useState } from "react";
import {
  readConnectionReturn,
  stripConnectionReturn,
  type ConnectionReturn,
} from "./result-contract.js";

/**
 * The return a connection surface was opened with, read once on mount and cleared from the
 * location after the router commits so a reload or the initial URL cannot replay it. The setter
 * lets the surface report an outcome it produced itself, such as a disconnect.
 */
export function useConnectionReturn() {
  const state = useState(readCurrentConnectionReturn);
  useEffect(stripCurrentConnectionReturn, []);
  return state;
}

function readCurrentConnectionReturn(): ConnectionReturn | undefined {
  if (typeof window === "undefined") return undefined;
  return readConnectionReturn(new URL(window.location.href));
}

function stripCurrentConnectionReturn(): void {
  const url = new URL(window.location.href);
  if (!stripConnectionReturn(url)) return;
  window.history.replaceState(window.history.state, "", url);
}
