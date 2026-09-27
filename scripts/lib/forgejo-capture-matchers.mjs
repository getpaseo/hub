import { sleep } from "./forgejo-capture-instance.mjs";

/** True when a delivery carries the given X-Forgejo-Event header and passes a body check. */
export function isEvent(eventHeader, bodyPredicate) {
  return (delivery) => {
    if (delivery.headers["x-forgejo-event"] !== eventHeader) return false;
    let body;
    try {
      body = JSON.parse(delivery.body);
    } catch {
      return false;
    }
    return bodyPredicate(body);
  };
}

export function hasLabel(body, name) {
  return (body.issue?.labels ?? body.pull_request?.labels ?? []).some((l) => l.name === name);
}

/** Forgejo delivers off an async queue, so deliveries can arrive out of order. Scans forward from `fromIndex` instead of trusting that position. */
export async function waitMatching(listener, fromIndex, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (let i = fromIndex; i < listener.deliveries.length; i += 1) {
      if (predicate(listener.deliveries[i])) return { index: i, delivery: listener.deliveries[i] };
    }
    await sleep(200);
  }
  const unmatched = listener.deliveries
    .slice(fromIndex)
    .map((d) => `${d.headers["x-forgejo-event"]}/${JSON.parse(d.body || "{}").action}`);
  throw new Error(`no delivery matched; unmatched since #${fromIndex}: ${unmatched.join(", ")}`);
}
