import type { JsonPrimitive } from "../config/schema.js";

export type InvocationInputType = "string" | "number" | "boolean";

export interface InvocationInputDefinition {
  type: InvocationInputType;
  required?: boolean | undefined;
  default?: JsonPrimitive | undefined;
  choices?: readonly JsonPrimitive[] | undefined;
}

export type InvocationInputDefinitions = Readonly<Record<string, InvocationInputDefinition>>;
export type InvocationInputs = Readonly<Record<string, JsonPrimitive>>;

export type InvocationParseResult =
  | {
      status: "accepted";
      rawMessage: string;
      prompt: string;
      inputs: InvocationInputs;
    }
  | {
      status: "rejected";
      rawMessage: string;
      prompt: string;
      inputs: InvocationInputs;
      reason: string;
    };

export function parseInvocation(
  rawMessage: string,
  definitions: InvocationInputDefinitions,
  mention?: string,
): InvocationParseResult {
  const promptAfterMention = removeMention(rawMessage, mention);
  const inputs: Record<string, JsonPrimitive> = {};
  const consumed = consumeDeclaredHeaders(promptAfterMention, definitions, inputs);
  const prompt = consumed.prompt;

  if (consumed.reason !== undefined) {
    return rejected(rawMessage, prompt, inputs, consumed.reason);
  }

  const defaults = applyDefaults(definitions, inputs);
  if (defaults !== undefined) {
    return rejected(rawMessage, prompt, inputs, defaults);
  }

  const required = findMissingRequiredInput(definitions, inputs);
  if (required !== undefined) {
    return rejected(rawMessage, prompt, inputs, `required input ${required} is missing`);
  }

  return {
    status: "accepted",
    rawMessage,
    prompt,
    inputs: freezeInputs(inputs),
  };
}

export function matchesInputFilters(
  inputs: InvocationInputs,
  filters: Readonly<Record<string, JsonPrimitive>> | undefined,
): boolean {
  if (filters === undefined) return true;
  return Object.entries(filters).every(([name, value]) => inputs[name] === value);
}

export function interpolateInvocation(
  template: string,
  invocation: Extract<InvocationParseResult, { status: "accepted" }>,
): string {
  return template.replace(
    /\$\{\{\s*paseo\.(prompt|inputs\.([a-z][a-z0-9_-]*))\s*\}\}/gu,
    (_expression, path: string, inputName: string | undefined) => {
      if (path === "prompt") return invocation.prompt;
      const value = inputName === undefined ? undefined : invocation.inputs[inputName];
      if (value === undefined) throw new Error(`invocation input ${inputName} is unavailable`);
      return String(value);
    },
  );
}

function consumeDeclaredHeaders(
  message: string,
  definitions: InvocationInputDefinitions,
  inputs: Record<string, JsonPrimitive>,
): { prompt: string; reason?: string } {
  let offset = 0;
  while (offset < message.length) {
    const token = readNextToken(message, offset);
    if (token === undefined) break;
    const definition = definitions[token.name];
    if (definition === undefined) break;
    if (Object.hasOwn(inputs, token.name)) {
      return {
        prompt: message.slice(offset),
        reason: `duplicate input ${token.name}`,
      };
    }
    const value = parseInputValue(token.name, token.value, definition);
    if (!value.ok) return { prompt: message.slice(offset), reason: value.reason };
    inputs[token.name] = value.value;
    offset = token.end;
  }

  return { prompt: message.slice(offset) };
}

function applyDefaults(
  definitions: InvocationInputDefinitions,
  inputs: Record<string, JsonPrimitive>,
): string | undefined {
  for (const [name, definition] of Object.entries(definitions)) {
    if (Object.hasOwn(inputs, name) || definition.default === undefined) continue;
    const parsed = parseDefaultValue(name, definition.default, definition);
    if (parsed !== undefined) return parsed;
    inputs[name] = definition.default;
  }
  return undefined;
}

function parseDefaultValue(
  name: string,
  value: JsonPrimitive,
  definition: InvocationInputDefinition,
): string | undefined {
  if (!isValueForType(value, definition.type)) {
    return `input ${name} default does not match type ${definition.type}`;
  }
  if (definition.choices !== undefined && !definition.choices.some((choice) => choice === value)) {
    return `input ${name} default is not one of the declared choices`;
  }
  return undefined;
}

function findMissingRequiredInput(
  definitions: InvocationInputDefinitions,
  inputs: Record<string, JsonPrimitive>,
): string | undefined {
  return Object.entries(definitions).find(
    ([name, definition]) => definition.required === true && !Object.hasOwn(inputs, name),
  )?.[0];
}

function parseInputValue(
  name: string,
  rawValue: string,
  definition: InvocationInputDefinition,
): { ok: true; value: JsonPrimitive } | { ok: false; reason: string } {
  let value: JsonPrimitive;
  if (definition.type === "string") {
    value = rawValue;
  } else if (definition.type === "number") {
    if (rawValue.length === 0 || !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(rawValue)) {
      return { ok: false, reason: `input ${name} must be a number` };
    }
    const number = Number(rawValue);
    if (!Number.isFinite(number)) return { ok: false, reason: `input ${name} must be a number` };
    value = number;
  } else {
    if (rawValue === "true") value = true;
    else if (rawValue === "false") value = false;
    else return { ok: false, reason: `input ${name} must be a boolean` };
  }

  if (definition.choices !== undefined && !definition.choices.some((choice) => choice === value)) {
    return { ok: false, reason: `input ${name} must be one of the declared choices` };
  }
  return { ok: true, value };
}

function readNextToken(
  message: string,
  offset: number,
): { name: string; value: string; end: number } | undefined {
  const start = offset;
  const match = /^([a-z][a-z0-9_-]*)=([^\s]*)(?:\s+|$)/u.exec(message.slice(start));
  if (match === null) return undefined;
  return {
    name: match[1]!,
    value: match[2]!,
    end: start + match[0].length,
  };
}

function removeMention(rawMessage: string, mention: string | undefined): string {
  if (mention === undefined) return rawMessage.trimStart();
  const index = rawMessage.indexOf(mention);
  return index < 0 ? rawMessage.trimStart() : rawMessage.slice(index + mention.length).trimStart();
}

function isValueForType(value: JsonPrimitive, type: InvocationInputType): boolean {
  if (type === "string") return typeof value === "string";
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === "boolean";
}

function freezeInputs(inputs: Record<string, JsonPrimitive>): InvocationInputs {
  return Object.freeze({ ...inputs });
}

function rejected(
  rawMessage: string,
  prompt: string,
  inputs: Record<string, JsonPrimitive>,
  reason: string,
): InvocationParseResult {
  return {
    status: "rejected",
    rawMessage,
    prompt,
    inputs: freezeInputs(inputs),
    reason,
  };
}
