import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

export async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function record(value: unknown, label: string): Record<string, unknown> {
  assert.equal(isRecord(value), true, label);
  if (!isRecord(value)) throw new Error(label);
  return value;
}

export function field(value: Record<string, unknown>, key: string): unknown {
  return value[key];
}

export function text(value: unknown, label: string): string {
  assert.equal(typeof value, "string", label);
  if (typeof value !== "string") throw new Error(label);
  return value;
}

export function integer(value: unknown, label: string): number {
  assert.equal(typeof value === "number" && Number.isInteger(value), true, label);
  if (typeof value !== "number") throw new Error(label);
  return value;
}

export function list(value: unknown, label: string): unknown[] {
  assert.equal(Array.isArray(value), true, label);
  if (!Array.isArray(value)) throw new Error(label);
  return value;
}

export function texts(value: unknown, label: string): string[] {
  return list(value, label).map((entry, index) => text(entry, `${label}[${String(index)}]`));
}

export function deliveryNamed(deliveries: unknown, name: string): Record<string, unknown> {
  const found = list(deliveries, "deliveries").find(
    (entry) => field(record(entry, name), "name") === name,
  );
  return record(found, name);
}
