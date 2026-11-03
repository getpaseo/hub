import { createHash } from "node:crypto";
import { reportFailure } from "../../failures/index.js";
import { readBoundedRequestBody } from "../../http/request-body.js";
import {
  extractBearerToken,
  type GoogleChatOidcVerifier,
} from "../../providers/google-chat/oidc.js";
import type { TriggerHandler, TriggerSource } from "../index.js";
import {
  GoogleChatEventIntakeValidationError,
  intakeGoogleChatEvent,
  type GoogleChatEventIntakeOptions,
} from "./intake.js";

const MAX_WEBHOOK_BYTES = 1_048_576;

export interface GoogleChatWebhookSourceOptions extends GoogleChatEventIntakeOptions {
  verifier: GoogleChatOidcVerifier;
}

export interface GoogleChatWebhookEndpoint extends TriggerSource {
  handle(request: Request): Promise<Response>;
}

interface VerifiedGoogleChatWebhookRequest {
  payload: unknown;
  signatureHash: string;
}

export function createGoogleChatWebhookSource(
  options: GoogleChatWebhookSourceOptions,
): GoogleChatWebhookEndpoint {
  const handlers = new Set<TriggerHandler>();

  return {
    async handle(request) {
      const verified = await verifyGoogleChatWebhookRequest(request, options.verifier);
      if (verified instanceof Response) return verified;

      try {
        await intakeGoogleChatEvent(verified.payload, verified.signatureHash, handlers, options);
        return Response.json({});
      } catch (error) {
        if (error instanceof GoogleChatEventIntakeValidationError) {
          reportFailure(
            error,
            {
              operation: "google-chat.webhook.validate",
              component: "triggers",
              provider: "google-chat",
              status: 400,
            },
            { status: 400, kind: "validation" },
          );
          return Response.json({ error: "invalid_google_chat_event" }, { status: 400 });
        }
        reportFailure(
          error,
          {
            operation: "google-chat.webhook.handoff",
            component: "triggers",
            provider: "google-chat",
            status: 503,
          },
          { status: 503 },
        );
        return Response.json({ error: "event_handoff_unavailable" }, { status: 503 });
      }
    },
    async start(handler) {
      handlers.add(handler);
    },
    async stop() {
      handlers.clear();
    },
  };
}

async function verifyGoogleChatWebhookRequest(
  request: Request,
  verifier: GoogleChatOidcVerifier,
): Promise<VerifiedGoogleChatWebhookRequest | Response> {
  const authorizationHeader = request.headers.get("authorization");
  let token: string;
  try {
    token = extractBearerToken(authorizationHeader);
    await verifier.verifyBearerToken(token);
  } catch (error) {
    reportFailure(
      error,
      {
        operation: "google-chat.webhook.verify",
        component: "triggers",
        provider: "google-chat",
        status: 401,
      },
      {
        status: 401,
        kind: "authentication",
        ...(authorizationHeader === null ? {} : { scrubValues: [authorizationHeader] }),
      },
    );
    return new Response("Unauthorized", { status: 401 });
  }

  const body = await readBoundedRequestBody(request, MAX_WEBHOOK_BYTES);
  if (body instanceof Response) return body;

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch (error) {
    reportFailure(
      error,
      {
        operation: "google-chat.webhook.parse",
        component: "triggers",
        provider: "google-chat",
        status: 400,
      },
      { status: 400, kind: "validation", scrubValues: [token] },
    );
    return Response.json({ error: "request body must be valid JSON" }, { status: 400 });
  }

  return {
    payload,
    signatureHash: createHash("sha256").update(token).digest("hex"),
  };
}
