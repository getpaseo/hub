export function formatDuration(milliseconds: number): string {
  if (milliseconds % 3_600_000 === 0) return `${String(milliseconds / 3_600_000)}h`;
  if (milliseconds % 60_000 === 0) return `${String(milliseconds / 60_000)}m`;
  if (milliseconds % 1000 === 0) return `${String(milliseconds / 1000)}s`;
  return `${String(milliseconds)}ms`;
}
