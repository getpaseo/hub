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
    assert.doesNotMatch(optional, /aria-hidden="true"[^>]*>\*</u);
    assert.match(mandatory, /required/u);
    assert.match(mandatory, /aria-hidden="true"[^>]*>\*</u);
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
