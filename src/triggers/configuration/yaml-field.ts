import type { Document } from "yaml";

export function setYamlField(document: Document, path: readonly string[], value: unknown): void {
  if (value === undefined) {
    if (document.hasIn(path)) document.deleteIn(path);
  } else if (JSON.stringify(document.getIn(path)) !== JSON.stringify(value))
    document.setIn(path, value);
}
