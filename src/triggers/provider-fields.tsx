/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-function-as-prop, eslint-plugin-react-perf/jsx-no-new-object-as-prop -- controls bind one registered field and its patch */
import { useState } from "react";
import { Combobox } from "../components/app/combobox.js";
import { Disclosure } from "../components/app/disclosure.js";
import { FormField } from "../components/app/form-field.js";
import { browserConfiguration } from "../providers/browser.js";
import type { ProviderFormConnection, ProviderFormSection } from "../providers/configuration.js";
import type { TriggerFieldErrors, TriggerFormValue } from "./configuration/editor.js";

export function ProviderTriggerFields({
  form,
  errors,
  connections,
  onChange,
}: {
  form: TriggerFormValue;
  errors: TriggerFieldErrors;
  connections: readonly ProviderFormConnection[];
  onChange: (value: TriggerFormValue) => void;
}) {
  return (
    <>
      {browserConfiguration.formSections(form, connections).map((section) => (
        <ProviderSection
          key={section.id}
          section={section}
          errors={errors}
          onChange={(key, value) => onChange({ ...form, [key]: value })}
        />
      ))}
    </>
  );
}

function ProviderSection({
  section,
  errors,
  onChange,
}: {
  section: ProviderFormSection;
  errors: TriggerFieldErrors;
  onChange: (key: string, value: string) => void;
}) {
  const [open, setOpen] = useState(section.initialOpen);
  return (
    <Disclosure
      id={section.id}
      open={open}
      onOpenChange={setOpen}
      title={section.title}
      description={section.description}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {section.fields.map((field) => {
          const error = errors[field.key];
          const frame = {
            id: field.id,
            label: field.label,
            description: field.description,
            ...(field.required === undefined ? {} : { required: field.required }),
            ...(error === undefined ? {} : { error }),
          };
          return field.kind === "choice" ? (
            <FormField key={field.key} {...frame}>
              {(control) => (
                <Combobox
                  {...control}
                  value={field.value}
                  options={field.options}
                  placeholder={field.placeholder}
                  empty={field.empty}
                  onChange={(option) => onChange(field.key, option.value)}
                />
              )}
            </FormField>
          ) : (
            <FormField
              key={field.key}
              {...frame}
              kind={field.kind}
              name={field.key}
              value={field.value}
              {...(field.placeholder === undefined ? {} : { placeholder: field.placeholder })}
              onChange={(value) => onChange(field.key, value)}
            />
          );
        })}
      </div>
    </Disclosure>
  );
}
