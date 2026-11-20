import { markdownLanguage } from "@codemirror/lang-markdown";

export function withExecutionLink(
  content: string,
  url: string | undefined,
  syntax: "markdown" | "slack" = "markdown",
): string {
  if (url === undefined) return content;
  const hasLink = syntax === "slack" ? hasSlackLink : hasMarkdownLink;
  if (content.includes(url) && hasLink(content, url)) return content;
  const footer = syntax === "slack" ? `<${url}|Open in Paseo>` : `[Open in Paseo](${url})`;
  return `${content.trimEnd()}\n\n${footer}`;
}

function hasSlackLink(content: string, url: string): boolean {
  const text = content.replace(/(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/gu, "");
  return (
    text
      .match(/https?:\/\/[^\s<>"|`\])]+/gu)
      ?.some((candidate) => candidate.replace(/[.,;!:?]+$/u, "") === url) ?? false
  );
}

function hasMarkdownLink(content: string, url: string): boolean {
  const definitions = new Map<string, string>();
  const references = new Set<string>();
  let found = false;
  const source = ({ from, to }: { from: number; to: number }) => content.slice(from, to);
  markdownLanguage.parser.parse(content).iterate({
    enter(ref) {
      if (found || ref.name === "Image") return false;
      const node = ref.node;
      if (ref.name === "LinkReference") {
        const label = node.getChild("LinkLabel");
        const target = node.getChild("URL");
        if (label && target) {
          const key = referenceKey(source(label));
          if (!definitions.has(key)) definitions.set(key, source(target));
        }
        return false;
      }
      if (ref.name === "Link") {
        const [open, close, destination] = node.getChildren("LinkMark");
        if (destination) {
          const target = node.getChildren("URL").find(({ from }) => from >= destination.to);
          found = target !== undefined && matchesUrl(source(target), url);
        } else if (open && close) {
          const label = node.getChild("LinkLabel");
          const key = label ? referenceKey(source(label)) : "";
          references.add(key || referenceKey(content.slice(open.from, close.to)));
        }
        return false;
      }
      if (ref.name === "URL") found = matchesUrl(source(ref), url);
      return undefined;
    },
  });
  return found || [...references].some((key) => matchesUrl(definitions.get(key), url));
}

function referenceKey(label: string): string {
  return label.slice(1, -1).trim().replace(/\s+/gu, " ").toLowerCase();
}

function matchesUrl(candidate: string | undefined, url: string): boolean {
  return candidate === url || candidate === `<${url}>`;
}
