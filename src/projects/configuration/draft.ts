/**
 * The set of files the configuration editor has open: the YAML document and the
 * prompt partials it includes. A revision is immutable, so a draft is never
 * partially saved — one save activates the whole set or none of it.
 *
 * Paths here are the `include:` form (relative to `.paseo/partials/`), which is
 * both what the YAML names and what the save boundary accepts.
 */

/** Identifies the YAML document in a draft. Partials are identified by their path. */
export const CONFIGURATION_DOCUMENT_ID = "hub.yml";

export interface ConfigurationFile {
  path: string;
  content: string;
}

export interface ConfigurationDocument {
  /** Stable id used for selection; also the label in the file list. */
  id: string;
  /** Path as the daemon sees it, shown above the editor. */
  label: string;
  content: string;
  language: "yaml" | "markdown";
  isPartial: boolean;
}

export interface ConfigurationDraft {
  yaml: string;
  partials: readonly ConfigurationFile[];
  selectedId: string;
}

export function configurationDraft(revision: {
  rawYaml: string | null;
  partials: readonly ConfigurationFile[];
}): ConfigurationDraft {
  return {
    yaml: revision.rawYaml ?? EMPTY_CONFIGURATION,
    partials: [...revision.partials].sort(byPath),
    selectedId: CONFIGURATION_DOCUMENT_ID,
  };
}

export const EMPTY_CONFIGURATION = "environments: []\ntriggers: []\n";

export function documentsOf(draft: ConfigurationDraft): readonly ConfigurationDocument[] {
  return [
    {
      id: CONFIGURATION_DOCUMENT_ID,
      label: CONFIGURATION_DOCUMENT_ID,
      content: draft.yaml,
      language: "yaml",
      isPartial: false,
    },
    ...draft.partials.map((partial) => ({
      id: partial.path,
      label: `.paseo/partials/${partial.path}`,
      content: partial.content,
      language: "markdown" as const,
      isPartial: true,
    })),
  ];
}

export function selectedDocument(draft: ConfigurationDraft): ConfigurationDocument {
  const documents = documentsOf(draft);
  return documents.find((document) => document.id === draft.selectedId) ?? documents[0]!;
}

export function selectDocument(draft: ConfigurationDraft, id: string): ConfigurationDraft {
  return documentsOf(draft).some((document) => document.id === id)
    ? { ...draft, selectedId: id }
    : draft;
}

export function editSelected(draft: ConfigurationDraft, content: string): ConfigurationDraft {
  if (draft.selectedId === CONFIGURATION_DOCUMENT_ID) return { ...draft, yaml: content };
  return {
    ...draft,
    partials: draft.partials.map((partial) =>
      partial.path === draft.selectedId ? { ...partial, content } : partial,
    ),
  };
}

export class PartialPathUnavailable extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "PartialPathUnavailable";
  }
}

/** Adds an empty partial and selects it. The YAML must still `include:` it to save. */
export function addPartial(draft: ConfigurationDraft, path: string): ConfigurationDraft {
  const normalized = path.trim().replace(/^\/+/u, "");
  if (normalized.length === 0) throw new PartialPathUnavailable("Enter a path for the partial.");
  if (draft.partials.some((partial) => partial.path === normalized)) {
    throw new PartialPathUnavailable(`A partial already exists at ${normalized}.`);
  }
  return {
    ...draft,
    partials: [...draft.partials, { path: normalized, content: "" }].sort(byPath),
    selectedId: normalized,
  };
}

export function removePartial(draft: ConfigurationDraft, path: string): ConfigurationDraft {
  const partials = draft.partials.filter((partial) => partial.path !== path);
  if (partials.length === draft.partials.length) return draft;
  return {
    ...draft,
    partials,
    selectedId: draft.selectedId === path ? CONFIGURATION_DOCUMENT_ID : draft.selectedId,
  };
}

/** True once the draft differs from the revision it was opened from. */
export function isModified(draft: ConfigurationDraft, baseline: ConfigurationDraft): boolean {
  if (draft.yaml !== baseline.yaml) return true;
  if (draft.partials.length !== baseline.partials.length) return true;
  return draft.partials.some((partial, index) => {
    const original = baseline.partials[index];
    return original === undefined
      ? true
      : partial.path !== original.path || partial.content !== original.content;
  });
}

function byPath(left: ConfigurationFile, right: ConfigurationFile): number {
  return left.path.localeCompare(right.path);
}
