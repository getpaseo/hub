import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  addPartial,
  configurationDraft,
  documentsOf,
  editSelected,
  isModified,
  PartialPathUnavailable,
  removePartial,
  selectDocument,
  selectedDocument,
  CONFIGURATION_DOCUMENT_ID,
  EMPTY_CONFIGURATION,
} from "./draft.js";

const revision = {
  rawYaml: "environments: []\ntriggers: []\n",
  partials: [
    { path: "triage/preamble.md", content: "Triage first." },
    { path: "shared/labels.md", content: "Labels." },
  ],
};

describe("configuration draft", () => {
  it("opens on the YAML document with partials listed under it", () => {
    const draft = configurationDraft(revision);

    assert.equal(selectedDocument(draft).id, CONFIGURATION_DOCUMENT_ID);
    assert.equal(selectedDocument(draft).language, "yaml");
    assert.deepEqual(
      documentsOf(draft).map((document) => document.id),
      [CONFIGURATION_DOCUMENT_ID, "shared/labels.md", "triage/preamble.md"],
    );
    assert.deepEqual(
      documentsOf(draft).map((document) => document.label),
      [
        CONFIGURATION_DOCUMENT_ID,
        ".paseo/partials/shared/labels.md",
        ".paseo/partials/triage/preamble.md",
      ],
    );
  });

  it("starts a project with no revision on an empty configuration", () => {
    const draft = configurationDraft({ rawYaml: null, partials: [] });

    assert.equal(draft.yaml, EMPTY_CONFIGURATION);
    assert.equal(isModified(draft, draft), false);
  });

  it("edits the selected document and leaves the others alone", () => {
    const draft = configurationDraft(revision);
    const edited = editSelected(
      selectDocument(draft, "triage/preamble.md"),
      "Triage with the checklist.",
    );

    assert.equal(selectedDocument(edited).content, "Triage with the checklist.");
    assert.equal(edited.yaml, revision.rawYaml);
    assert.equal(
      edited.partials.find((partial) => partial.path === "shared/labels.md")?.content,
      "Labels.",
    );
    assert.equal(isModified(edited, draft), true);
  });

  it("reports no modification when content is retyped identically", () => {
    const draft = configurationDraft(revision);

    assert.equal(isModified(editSelected(draft, revision.rawYaml), draft), false);
  });

  it("adds an empty partial, selects it, and edits markdown", () => {
    const draft = addPartial(configurationDraft(revision), "review/checklist.md");

    assert.equal(draft.selectedId, "review/checklist.md");
    assert.equal(selectedDocument(draft).language, "markdown");
    assert.equal(selectedDocument(draft).content, "");
    assert.equal(isModified(draft, configurationDraft(revision)), true);
    assert.deepEqual(
      editSelected(draft, "## Checklist").partials.find(
        (partial) => partial.path === "review/checklist.md",
      ),
      { path: "review/checklist.md", content: "## Checklist" },
    );
  });

  it("refuses a duplicate or empty partial path", () => {
    const draft = configurationDraft(revision);

    assert.throws(() => addPartial(draft, "triage/preamble.md"), PartialPathUnavailable);
    assert.throws(() => addPartial(draft, "   "), PartialPathUnavailable);
    assert.equal(addPartial(draft, "/leading.md").selectedId, "leading.md");
  });

  it("returns to the YAML document when the open partial is removed", () => {
    const draft = removePartial(
      selectDocument(configurationDraft(revision), "triage/preamble.md"),
      "triage/preamble.md",
    );

    assert.equal(draft.selectedId, CONFIGURATION_DOCUMENT_ID);
    assert.deepEqual(
      draft.partials.map((partial) => partial.path),
      ["shared/labels.md"],
    );
    assert.equal(isModified(draft, configurationDraft(revision)), true);
  });

  it("ignores selection of a document the draft does not have", () => {
    const draft = configurationDraft(revision);

    assert.equal(selectDocument(draft, "missing.md").selectedId, CONFIGURATION_DOCUMENT_ID);
  });
});
