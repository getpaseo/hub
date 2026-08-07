import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import {
  MAX_PROMPT_PARTIAL_CONTENT_BYTES,
  MAX_PROMPT_PARTIAL_COUNT,
  MAX_PROMPT_PARTIAL_PATH_LENGTH,
} from "../config/prompt-partials.js";

extendZodWithOpenApi(z);

export const FieldIssueSchema = z
  .object({
    path: z.array(z.union([z.string(), z.number().int()])),
    message: z.string(),
  })
  .strict()
  .openapi("FieldIssue", {
    example: { path: ["projectSlug"], message: "Required" },
  });

export const ProblemSchema = z
  .object({
    type: z.string().url(),
    title: z.string(),
    status: z.number().int().min(400).max(599),
    detail: z.string(),
    code: z.string(),
    requestId: z.string(),
    issues: z.array(FieldIssueSchema).optional(),
  })
  .strict()
  .openapi("Problem", {
    example: {
      type: "https://paseo.sh/problems/invalid-request",
      title: "Invalid request",
      status: 400,
      detail: "The request body contains invalid fields.",
      code: "invalid_request",
      requestId: "5e967c44-fc22-4f6d-8fc5-1bbff33121af",
      issues: [{ path: ["projectSlug"], message: "Required" }],
    },
  });

export const ConfigurationPartialSchema = z
  .object({
    path: z.string().min(1).max(MAX_PROMPT_PARTIAL_PATH_LENGTH),
    content: z.string().max(MAX_PROMPT_PARTIAL_CONTENT_BYTES),
  })
  .strict()
  .openapi("ConfigurationPartial", {
    description:
      "A UTF-8 prompt partial path relative to .paseo/partials/ and its exact text content.",
    example: { path: "docs/safety.md", content: "Follow the safety checklist." },
  });

export const InstallConfigurationRequestSchema = z
  .object({
    projectSlug: z.string().trim().min(1).max(100),
    yaml: z.string().min(1).max(1_000_000),
    partials: z.array(ConfigurationPartialSchema).max(MAX_PROMPT_PARTIAL_COUNT).optional(),
  })
  .strict()
  .openapi("InstallConfigurationRequest", {
    description:
      "Install YAML and, when prompt include references are used, exactly the referenced UTF-8 partial files. Partial paths are relative to .paseo/partials/; at most 100 files and 5,000,000 combined content bytes are accepted.",
    example: {
      projectSlug: "payments",
      yaml: [
        "project: acme/payments",
        "environments:",
        "  - name: runner",
        "    kind: daemon",
        "    daemon: build-server",
        "    cwd: /workspace",
        "triggers:",
        "  - name: deploy",
        "    on: manual.run",
        "    max_runtime: 1h",
        "    steps:",
        "      - id: deploy",
        "        environment: runner",
        "        max_runtime: 30m",
        "        idle_timeout: 5m",
        "        agent: { provider: test }",
        "        prompt:",
        "          - include: docs/safety.md",
      ].join("\n"),
      partials: [{ path: "docs/safety.md", content: "Follow the safety checklist." }],
    },
  });

export const InstalledConfigurationSchema = z
  .object({
    projectSlug: z.string(),
    versionId: z.string().uuid(),
    version: z.number().int().positive(),
    active: z.literal(true),
  })
  .strict()
  .openapi("InstalledConfiguration", {
    example: {
      projectSlug: "payments",
      versionId: "84af3583-23ff-4fcc-9838-ed3262499be2",
      version: 4,
      active: true,
    },
  });

export const DispatchManualRunRequestSchema = z
  .object({
    projectSlug: z.string().trim().min(1).max(100),
    expectedVersionId: z.string().uuid().optional(),
    trigger: z.string().trim().min(1).max(200),
    actor: z.string().trim().min(1).max(200),
    deliveryKey: z.string().trim().min(1).max(200),
    input: z.unknown(),
  })
  .strict()
  .openapi("DispatchManualRunRequest", {
    example: {
      projectSlug: "payments",
      trigger: "deploy",
      actor: "automation",
      deliveryKey: "deploy-2026-08-06",
      input: { environment: "production" },
    },
  });

export const DispatchedManualRunSchema = z
  .object({
    deliveryKey: z.string(),
    providerEventReceiptId: z.string().uuid(),
    triggerRunId: z.string().uuid(),
    configuredTriggerName: z.string(),
    workflowStatus: z.enum(["running", "succeeded", "failed", "timed_out"]),
  })
  .strict()
  .openapi("DispatchedManualRun", {
    example: {
      deliveryKey: "deploy-2026-08-06",
      providerEventReceiptId: "845e9d26-7977-45e1-bc69-d80a7b55a9cc",
      triggerRunId: "f83dc934-02a0-4849-8de7-699110be24ed",
      configuredTriggerName: "deploy",
      workflowStatus: "running",
    },
  });

export const EnrollmentTokenSchema = z
  .object({
    token: z.string().min(32),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .openapi("EnrollmentToken", {
    example: {
      token: "one-time-secret-returned-only-once",
      expiresAt: "2026-08-06T18:10:00.000Z",
    },
  });

export type Problem = z.infer<typeof ProblemSchema>;
