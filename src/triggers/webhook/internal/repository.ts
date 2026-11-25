import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { DatabaseRuntime, QueryHandle } from "../../../db/runtime/index.js";
import { acceptWorkflowRun } from "../../../db/workflow-intake.js";
import { parseCompiledHubConfig } from "../../../config/compiler.js";
import { defaultInputs } from "../../invocation.js";
import type { WebhookEndpoint, WebhookStore } from "../index.js";
import { frameWebhookPrompt } from "./prompt.js";

const deliveriesPerMinute = 60;
const minuteMs = 60_000;
const emptyDigest = Buffer.alloc(32);

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function generateSecret(): string {
  return `whsec_${randomBytes(32).toString("base64url")}`;
}

function matchesSecret(token: string, hash: string | null | undefined): boolean {
  const stored = hash == null ? emptyDigest : Buffer.from(hash, "hex");
  return timingSafeEqual(digest(token), stored) && hash != null;
}

export class WebhookRepository implements WebhookStore {
  constructor(private readonly runtime: DatabaseRuntime) {}

  /**
   * Trigger save owns the trigger row lock and activates the endpoint with its revision. Every
   * delivery needs a bearer secret, so an endpoint is born with one, and its plaintext is returned
   * this once. An endpoint that already exists keeps its secret.
   */
  static async synchronize(
    client: QueryHandle,
    triggerId: string,
    configured: boolean,
  ): Promise<string | undefined> {
    if (!configured) {
      await client.query("delete from trigger_webhooks where trigger_id = $1", [triggerId]);
      return undefined;
    }
    const secret = generateSecret();
    const { rows } = await client.query(
      `insert into trigger_webhooks (trigger_id, endpoint_id, secret_hash) values ($1, $2, $3)
       on conflict (trigger_id) do nothing returning endpoint_id`,
      [triggerId, `wh_${randomBytes(24).toString("base64url")}`, digest(secret).toString("hex")],
    );
    return rows.length === 0 ? undefined : secret;
  }

  async list(organizationId: string): Promise<WebhookEndpoint[]> {
    return (
      await this.runtime.query<WebhookEndpoint & Record<string, unknown>>(
        `select t.id as "triggerId", w.endpoint_id as "endpointId",
                w.secret_hash is not null as "hasSecret"
         from trigger_webhooks w join organization_triggers t on t.id = w.trigger_id
         where t.organization_id = $1`,
        [organizationId],
      )
    ).rows;
  }

  async rotate(
    organizationId: string,
    triggerId: string,
    action: NonNullable<Parameters<WebhookStore["rotate"]>[2]> = "rotate",
  ) {
    const secret = generateSecret();
    const {
      rows: [endpoint],
    } = await this.runtime.query<{ endpoint_id: string }>(
      `update trigger_webhooks w set secret_hash = $3
       from organization_triggers t where t.id = w.trigger_id and t.id = $1
         and t.organization_id = $2 and ($4 = 'rotate' or w.secret_hash is null)
       returning w.endpoint_id`,
      [triggerId, organizationId, digest(secret).toString("hex"), action],
    );
    return endpoint === undefined ? undefined : { endpointId: endpoint.endpoint_id, secret };
  }

  async authenticate(endpointId: string, token: string): Promise<string | undefined> {
    const {
      rows: [endpoint],
    } = await this.runtime.query<{
      secret_hash: string | null;
      organization_id: string;
    }>(
      `select w.secret_hash, t.organization_id from trigger_webhooks w
       join organization_triggers t on t.id = w.trigger_id where w.endpoint_id = $1`,
      [endpointId],
    );
    return matchesSecret(token, endpoint?.secret_hash) ? endpoint?.organization_id : undefined;
  }

  async accept(input: Parameters<WebhookStore["accept"]>[0]): ReturnType<WebhookStore["accept"]> {
    return this.runtime.transaction(async (client) => {
      // Serialize acceptance with trigger edits. Read the active revision after acquiring the lock.
      const {
        rows: [trigger],
      } = await client.query<{
        organization_id: string;
        runtime_project_id: string;
        enabled: boolean;
      }>(
        `select t.organization_id, t.runtime_project_id, t.enabled
         from organization_triggers t join trigger_webhooks w on w.trigger_id = t.id
         where w.endpoint_id = $1 for update of t`,
        [input.endpointId],
      );
      const {
        rows: [endpoint],
      } = await client.query<{
        secret_hash: string | null;
        window_started_at: Date | null;
        window_count: number;
      }>(
        `select secret_hash, window_started_at, window_count
         from trigger_webhooks where endpoint_id = $1 for update`,
        [input.endpointId],
      );
      if (!matchesSecret(input.token, endpoint?.secret_hash) || !trigger || !endpoint) {
        return { status: "unauthorized" };
      }
      const key = input.idempotencyKey;
      const deliveryId =
        key === null
          ? `webhook:${input.endpointId}:delivery:${randomUUID()}`
          : `webhook:${input.endpointId}:key:${digest(key).toString("hex")}`;
      if (key !== null) {
        const {
          rows: [existing],
        } = await client.query<{ id: string }>(
          `select r.id from trigger_runs r join provider_event_receipts e
             on e.id = r.provider_event_receipt_id
           where e.organization_id = $1 and e.delivery_id = $2`,
          [trigger.organization_id, deliveryId],
        );
        if (existing) return { status: "accepted", runId: existing.id };
      }
      if (!trigger.enabled) return { status: "disabled" };
      if (!input.hasExecutionHeadroom) return { status: "limit" };
      const now = new Date(input.delivery.receivedAt);
      const inWindow =
        endpoint.window_started_at !== null &&
        now.getTime() - endpoint.window_started_at.getTime() < minuteMs;
      const count = inWindow ? endpoint.window_count : 0;
      if (count >= deliveriesPerMinute) return { status: "rate_limited" };
      const {
        rows: [revision],
      } = await client.query<{ id: string; normalized_configuration: unknown }>(
        `select r.id, r.normalized_configuration from projects p join project_configuration_revisions r
         on r.id = p.active_configuration_revision_id where p.id = $1 and p.status = 'active'`,
        [trigger.runtime_project_id],
      );
      if (!revision) return { status: "disabled" };
      const configuration = parseCompiledHubConfig(revision.normalized_configuration);
      const configured = configuration.triggers.find(({ on }) => on === "webhook.received");
      if (!configured) throw new Error("Webhook trigger configuration is missing.");
      const receiptId = randomUUID();
      await client.query(
        `insert into provider_event_receipts
           (id, organization_id, provider, delivery_id, source, payload, received_at, accepted_routes)
         values ($1, $2, 'webhook', $3, 'webhook.received', $4, $5, $6)`,
        [
          receiptId,
          trigger.organization_id,
          deliveryId,
          input.delivery,
          now,
          JSON.stringify([
            {
              projectId: trigger.runtime_project_id,
              configurationRevisionId: revision.id,
              connectionId: null,
              resourceId: null,
            },
          ]),
        ],
      );
      const accepted = await acceptWorkflowRun(client, {
        organizationId: trigger.organization_id,
        projectId: trigger.runtime_project_id,
        configurationRevisionId: revision.id,
        providerEventReceiptId: receiptId,
        configuredTriggerName: configured.name,
        prompt: frameWebhookPrompt(input.delivery),
        inputs: defaultInputs(configured.inputs),
        triggerContext: {
          provider: "webhook",
          deliveryId,
          event: { contentType: input.delivery.contentType, receivedAt: input.delivery.receivedAt },
        },
        outputContext: { provider: "webhook" },
        conversation: null,
        deadlineAt: new Date(now.getTime() + configured.maxRuntimeMs),
        stepIds: configured.steps.map(({ id }) => id),
        createdAt: now,
      });
      await client.query(
        `update trigger_webhooks set window_started_at = $2, window_count = $3 where endpoint_id = $1`,
        [input.endpointId, inWindow ? endpoint.window_started_at : now, count + 1],
      );
      return { status: "accepted", runId: accepted.id };
    });
  }
}
