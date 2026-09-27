// how long a receipt stays "enrichment pending" before a duplicate delivery treats its
// owner as dead and takes over; the owner itself gives up after a few seconds, so this
// old means the process died mid-enrichment. shared by the postgres and memory stores.
export const FORGEJO_ENRICHMENT_STALE_MS = 3 * 60_000;
