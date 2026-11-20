import { z } from "zod";

export function executionLinkPath(executionId: string): string {
  return `/open/executions/${encodeURIComponent(executionId)}`;
}

export function parseExecutionLinkId(value: string | null): string | undefined {
  const id = z.uuid().safeParse(value);
  return id.success ? id.data : undefined;
}

export function executionLinkUrl(
  publicBaseUrl: string | undefined,
  execution: { id: string; daemonId: string | null; daemonAgentId: string | null },
): string | undefined {
  if (!publicBaseUrl || !execution.daemonId || !execution.daemonAgentId?.trim()) return undefined;
  const url = new URL(executionLinkPath(execution.id), publicBaseUrl);
  return url.protocol === "https:" ? url.href : undefined;
}

export function withExecutionLink(
  content: string,
  url: string | undefined,
  syntax: "markdown" | "slack" = "markdown",
): string {
  if (url === undefined || containsClickableUrl(content, url)) return content;
  const footer = syntax === "slack" ? `<${url}|Open in Paseo>` : `[Open in Paseo](${url})`;
  return `${content.trimEnd()}\n\n${footer}`;
}

function containsClickableUrl(content: string, url: string): boolean {
  const text = content.replace(/(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/gu, "");
  return (
    text
      .match(/https?:\/\/[^\s<>"|`\])]+/gu)
      ?.some((candidate) => candidate.replace(/[.,;!:?]+$/u, "") === url) ?? false
  );
}
