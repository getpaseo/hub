import { createHash, createHmac } from "node:crypto";
import { z } from "zod";
import type { EmailDelivery, EmailMessage } from "../index.js";

const DELIVERY_TIMEOUT_MS = 10_000;
const SES_SERVICE = "ses";
const SES_SEND_EMAIL_PATH = "/v2/email/outbound-emails";

export interface SesCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface SesConfig {
  region: string;
  from: string;
  credentials: SesCredentials;
  configurationSet?: string;
}

type SendRequest = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type Environment = Record<string, string | undefined>;

const regionSchema = z
  .string()
  .regex(/^[a-z]{2}(-[a-z]+)+-\d+$/, "must be an AWS region such as eu-west-1");

const accessKeyIdSchema = z
  .string()
  .regex(/^[A-Z0-9]{16,128}$/, "must be an AWS access key ID of capital letters and digits");

const senderSchema = z.string().trim().min(1, "SES_FROM must not be blank");

function present(environment: Environment, name: string): string | undefined {
  const value = environment[name]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

function readCredentials(environment: Environment): SesCredentials {
  const usesSesNames =
    present(environment, "SES_ACCESS_KEY_ID") !== undefined ||
    present(environment, "SES_SECRET_ACCESS_KEY") !== undefined;
  const prefix = usesSesNames ? "SES" : "AWS";
  const idName = `${prefix}_ACCESS_KEY_ID`;
  const secretName = `${prefix}_SECRET_ACCESS_KEY`;
  const accessKeyId = present(environment, idName);
  const secretAccessKey = present(environment, secretName);
  if (accessKeyId === undefined && secretAccessKey === undefined) {
    throw new Error(
      "SES_ACCESS_KEY_ID and SES_SECRET_ACCESS_KEY (or AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY) are required when SES_FROM is set",
    );
  }
  if (accessKeyId === undefined) {
    throw new Error(`${idName} is required when ${secretName} is set`);
  }
  if (secretAccessKey === undefined) {
    throw new Error(`${secretName} is required when ${idName} is set`);
  }
  const id = accessKeyIdSchema.safeParse(accessKeyId);
  if (!id.success) {
    throw new Error(`${idName} is invalid: ${id.error.issues[0]?.message}`);
  }
  // A session token belongs to the key pair it was issued with, so it is read under the same prefix.
  const sessionToken = present(environment, `${prefix}_SESSION_TOKEN`);
  return {
    accessKeyId: id.data,
    secretAccessKey,
    ...(sessionToken === undefined ? {} : { sessionToken }),
  };
}

export function readSesConfig(environment: Environment): SesConfig | undefined {
  const rawFrom = environment["SES_FROM"];
  if (rawFrom === undefined || rawFrom.trim().length === 0) return undefined;
  const regionName = present(environment, "SES_REGION") === undefined ? "AWS_REGION" : "SES_REGION";
  const rawRegion = present(environment, regionName);
  if (rawRegion === undefined) {
    throw new Error("SES_REGION (or AWS_REGION) is required when SES_FROM is set");
  }
  const region = regionSchema.safeParse(rawRegion);
  if (!region.success) {
    throw new Error(`${regionName} is invalid: ${region.error.issues[0]?.message}`);
  }
  const credentials = readCredentials(environment);
  const configurationSet = present(environment, "SES_CONFIGURATION_SET");
  return {
    region: region.data,
    from: senderSchema.parse(rawFrom),
    credentials,
    ...(configurationSet === undefined ? {} : { configurationSet }),
  };
}

export interface AwsSignatureRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string;
  region: string;
  service: string;
  credentials: SesCredentials;
  now: Date;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * AWS Signature Version 4 for a single request. Returns the headers to add to `headers`: the
 * signed `Host` is taken from the URL and is left for the HTTP client to send.
 */
export function signAwsRequest(request: AwsSignatureRequest): Record<string, string> {
  const amzDate = request.now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  const date = amzDate.slice(0, 8);
  const added: Record<string, string> = { "X-Amz-Date": amzDate };
  if (request.credentials.sessionToken !== undefined) {
    added["X-Amz-Security-Token"] = request.credentials.sessionToken;
  }
  const signed = new Map<string, string>([["host", request.url.host]]);
  for (const [name, value] of Object.entries({ ...request.headers, ...added })) {
    signed.set(name.toLowerCase(), value.trim().replace(/\s+/g, " "));
  }
  const names = [...signed.keys()].sort();
  const signedHeaders = names.join(";");
  const canonicalQuery = [...request.url.searchParams]
    .map(([key, value]) => `${encodeRfc3986(key)}=${encodeRfc3986(value)}`)
    .sort()
    .join("&");
  const canonicalRequest = [
    request.method,
    request.url.pathname,
    canonicalQuery,
    ...names.map((name) => `${name}:${signed.get(name)}`),
    "",
    signedHeaders,
    sha256Hex(request.body),
  ].join("\n");
  const scope = `${date}/${request.region}/${request.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const signingKey = hmac(
    hmac(
      hmac(hmac(`AWS4${request.credentials.secretAccessKey}`, date), request.region),
      request.service,
    ),
    "aws4_request",
  );
  const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");
  return {
    ...added,
    Authorization: `AWS4-HMAC-SHA256 Credential=${request.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

export function createSesEmailDelivery(
  config: SesConfig,
  sendRequest: SendRequest = fetch,
  now: () => Date = () => new Date(),
): EmailDelivery {
  const url = new URL(`https://email.${config.region}.amazonaws.com${SES_SEND_EMAIL_PATH}`);
  return {
    async send(message: EmailMessage) {
      // SES v2 SendEmail has no idempotency key, so `message.idempotencyKey` cannot be honoured
      // here: a retried send after a lost response may deliver the email twice.
      const body = JSON.stringify({
        FromEmailAddress: config.from,
        Destination: { ToAddresses: [message.to] },
        Content: {
          Simple: {
            Subject: { Data: message.subject, Charset: "UTF-8" },
            Body: {
              Text: { Data: message.text, Charset: "UTF-8" },
              Html: { Data: message.html, Charset: "UTF-8" },
            },
          },
        },
        ...(config.configurationSet === undefined
          ? {}
          : { ConfigurationSetName: config.configurationSet }),
      });
      const headers = { "Content-Type": "application/json" };
      const response = await sendRequest(url.toString(), {
        method: "POST",
        headers: {
          ...headers,
          ...signAwsRequest({
            method: "POST",
            url,
            headers,
            body,
            region: config.region,
            service: SES_SERVICE,
            credentials: config.credentials,
            now: now(),
          }),
        },
        body,
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`Amazon SES rejected email with status ${response.status}`);
      }
    },
  };
}
