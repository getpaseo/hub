import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "vitest";

import { FormField } from "./form-field.js";

describe("a field's wiring", () => {
  it("points its label at the control and both notes at it in turn", () => {
    const markup = renderToStaticMarkup(
      <FormField
        id="client-secret"
        label="Client secret"
        description="Copied from the provider portal."
        error="This value is required."
        kind="secret"
        name="clientSecret"
        required
      />,
    );

    assert.match(markup, /for="client-secret"/u);
    assert.match(markup, /id="client-secret"/u);
    assert.match(markup, /aria-describedby="client-secret-description client-secret-error"/u);
    assert.match(markup, /id="client-secret-description"[^>]*>Copied from the provider portal\./u);
    assert.match(markup, /id="client-secret-error"[^>]*>This value is required\./u);
  });

  it("marks the control invalid only while there is an error to read", () => {
    const failing = renderToStaticMarkup(
      <FormField id="name" label="Name" error="Too short." kind="text" name="name" />,
    );
    const clean = renderToStaticMarkup(
      <FormField id="name" label="Name" kind="text" name="name" />,
    );

    assert.match(failing, /aria-invalid="true"/u);
    assert.match(failing, /data-invalid="true"/u);
    assert.match(clean, /aria-invalid="false"/u);
    assert.doesNotMatch(clean, /aria-describedby/u);
  });

  it("never requires a value the caller did not say was required", () => {
    const optional = renderToStaticMarkup(
      <FormField id="note" label="Note" kind="text" name="note" />,
    );
    const mandatory = renderToStaticMarkup(
      <FormField id="note" label="Note" kind="text" name="note" required />,
    );

    assert.doesNotMatch(optional, /required/u);
    assert.match(mandatory, /required/u);
  });

  it("leaves the label the words it was given, so a label lookup can ask for them", () => {
    const markup = renderToStaticMarkup(
      <FormField id="new-password" label="New password" kind="password" name="newPassword" />,
    );

    assert.match(markup, /for="new-password">New password<\/label>/u);
  });

  it("carries the constraints of a typed control instead of sending it to a render prop", () => {
    const slug = renderToStaticMarkup(
      <FormField
        id="project-slug"
        label="Project slug"
        kind="text"
        name="slug"
        pattern="[a-z0-9]+"
        maxLength={100}
        placeholder="triage"
      />,
    );
    const seats = renderToStaticMarkup(
      <FormField id="seats" label="Seat limit" kind="number" name="seats" min={1} step={1} />,
    );

    assert.match(slug, /pattern="\[a-z0-9\]\+"/u);
    assert.match(slug, /maxLength="100"/u);
    assert.match(slug, /placeholder="triage"/u);
    assert.match(seats, /type="number"/u);
    assert.match(seats, /min="1"/u);
    assert.match(seats, /step="1"/u);
  });

  it("hands the same attributes to a control it does not render itself", () => {
    const markup = renderToStaticMarkup(
      <FormField id="role" label="Role" description="Members cannot invite." error="Pick one.">
        {(control) => <select {...control} />}
      </FormField>,
    );

    assert.match(
      markup,
      /<select id="role" aria-invalid="true" aria-describedby="role-description role-error"/u,
    );
  });
});
