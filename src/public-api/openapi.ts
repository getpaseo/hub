import { OpenAPIRegistry, OpenApiGeneratorV31 } from "@asteasolutions/zod-to-openapi";
import { ProblemSchema } from "./contracts.js";
import { publicOperationManifest } from "./operation-manifest.js";

const registry = new OpenAPIRegistry();

registry.registerComponent("securitySchemes", "bearerAuth", {
  type: "http",
  scheme: "bearer",
  bearerFormat: "Paseo API key",
  description: "An organization API key. Each operation requires the scope shown on the operation.",
});

const requestIdResponseHeader = {
  "X-Request-ID": {
    description: "The accepted or generated request identifier.",
    schema: { type: "string" as const },
  },
};

for (const definition of publicOperationManifest) {
  const responses = Object.fromEntries(
    Object.entries(definition.responses).map(([status, description]) => [
      status,
      Number(status) === definition.successStatus
        ? {
            description,
            headers: requestIdResponseHeader,
            content: { "application/json": { schema: definition.successSchema } },
          }
        : {
            description,
            headers: {
              ...requestIdResponseHeader,
              ...(Number(status) === 401
                ? {
                    "WWW-Authenticate": {
                      description: "Bearer authentication challenge.",
                      schema: { type: "string" as const, example: "Bearer" },
                    },
                  }
                : {}),
            },
            content: { "application/problem+json": { schema: ProblemSchema } },
          },
    ]),
  );
  registry.registerPath({
    method: definition.method,
    path: definition.path,
    operationId: definition.id,
    summary: definition.summary,
    description: definition.description,
    tags: [definition.tag],
    security: [{ bearerAuth: [] }],
    ...(definition.requestSchema === undefined
      ? {}
      : {
          request: {
            body: {
              required: true,
              content: { "application/json": { schema: definition.requestSchema } },
            },
          },
        }),
    responses,
    "x-required-scopes": [definition.scope],
  });
}

export const publicOpenApiDocument = new OpenApiGeneratorV31(registry.definitions).generateDocument(
  {
    openapi: "3.1.0",
    info: {
      title: "Paseo Hub Public API",
      version: "1.0.0",
      description: "Install configuration, dispatch manual runs, and enroll Paseo daemons.",
    },
    servers: [{ url: "/", description: "This Hub instance" }],
    tags: [{ name: "Configurations" }, { name: "Runs" }, { name: "Daemons" }],
  },
);
