import { buildAgentDeepLink } from "@getpaseo/protocol/agent-deep-link";
import type { BrowserOrganizationAccess } from "../auth/browser-organization-access.js";
import { ProductRequestError } from "../auth/organization-access.js";
import type { AgentExecutionRecord, Database } from "../db/types.js";
import { executionLinkPath, parseExecutionLinkId } from "./link.js";

const privacyHeaders = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow",
};
const installUrl = "https://paseo.sh/download";

export function createExecutionLauncher(
  database: Database | null,
  auth: Pick<BrowserOrganizationAccess, "resolveAccount"> | undefined,
) {
  return async (request: Request, id: string): Promise<Response> => {
    const executionId = parseExecutionLinkId(id);
    if (executionId === undefined || database === null || auth === undefined) return notFound();
    const requestUrl = new URL(request.url);
    const viewRun = requestUrl.searchParams.get("view") === "run";

    let userId: string;
    try {
      userId = (await auth.resolveAccount(request)).account.id;
    } catch (error) {
      if (!(error instanceof ProductRequestError)) throw error;
      const status = error.response().status;
      if (status !== 401 && status !== 403) throw error;
      const resume = new URLSearchParams({ openExecution: executionId });
      if (viewRun) resume.set("view", "run");
      return new Response(null, {
        status: 303,
        headers: { ...privacyHeaders, location: `/?${resume}` },
      });
    }

    const execution = await database.findAgentExecutionById(executionId);
    if (!execution) return notFound();
    const slug = await database.findOrganizationSlugById(execution.organizationId);
    if (!slug) return notFound();
    const tenant = await database.resolveTenantRouteAccess(userId, slug);
    if (tenant?.organization.id !== execution.organizationId) return notFound();

    const path = executionLinkPath(executionId);
    if (viewRun) {
      return executionDetails(execution, path, slug);
    }
    if (!execution.daemonId || !execution.daemonAgentId?.trim()) return notFound();
    const daemon = await database.findDaemonForOrganization(
      execution.organizationId,
      execution.daemonId,
    );
    if (!daemon?.serverId.trim()) return notFound();
    const deepLink = buildAgentDeepLink({
      serverId: daemon.serverId,
      agentId: execution.daemonAgentId,
    });
    return document(
      "Open in Paseo",
      `<p>Open this agent session in the Paseo app.</p>
      <p><a class="primary" href="${escapeHtml(deepLink)}">Open in Paseo</a></p>
      <nav aria-label="Other options">
        <a href="${path}?view=run">View run in Hub</a>
        <a href="${installUrl}">Install Paseo</a>
      </nav>`,
    );
  };
}

function executionDetails(execution: AgentExecutionRecord, path: string, slug: string): Response {
  const activity = `/o/${escapeHtml(encodeURIComponent(slug))}/activity`;
  const start = execution.startedAt.toISOString();
  const end = execution.completedAt?.toISOString();
  const status = execution.status.replaceAll("_", " ");
  return document(
    "Execution details",
    `<dl>
      <dt>Status</dt><dd>${escapeHtml(status)}</dd>
      <dt>Started</dt><dd><time datetime="${start}">${start}</time></dd>
      ${end === undefined ? "" : `<dt>Completed</dt><dd><time datetime="${end}">${end}</time></dd>`}
    </dl>
    <nav aria-label="Execution links">
      <a href="${path}">Open in Paseo</a>
      <a href="${activity}">Organization activity</a>
    </nav>`,
  );
}

function notFound(): Response {
  return new Response("Not Found", { status: 404, headers: privacyHeaders });
}

function document(title: string, body: string): Response {
  return new Response(
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} · Paseo Hub</title>
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; padding: 1.5rem; min-height: 100svh; box-sizing: border-box;
      display: grid; place-items: center; font: 1rem/1.5 system-ui, sans-serif;
      background: #121212; color: #fafafa; }
    main { width: min(100%, 30rem); }
    h1 { font-size: 1.5rem; }
    a { color: #d4e3ff; }
    .primary { display: inline-block; padding: .6rem 1rem; border-radius: .5rem;
      background: #e4ecfc; color: #131b2a; text-decoration: none; }
    nav { display: flex; flex-wrap: wrap; gap: .75rem 1rem; }
    dd { margin: 0 0 .5rem; }
  </style>
</head>
<body><main><h1>${title}</h1>${body}</main></body>
</html>`,
    {
      headers: {
        ...privacyHeaders,
        "content-type": "text/html; charset=utf-8",
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      },
    },
  );
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}
