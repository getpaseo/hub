/**
 * Reads the JSON-RPC message an MCP HTTP response carries. A stateless 2025-era
 * exchange answers as a single SSE event; an error before dispatch answers as
 * plain JSON.
 */
export async function readMcpMessage(response: Response): Promise<unknown> {
  const text = await response.text();
  if (response.headers.get("content-type")?.startsWith("text/event-stream") !== true) {
    return JSON.parse(text);
  }
  const data = text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .filter((line) => line.length > 0);
  const message = data.at(-1);
  if (message === undefined) throw new Error("MCP event stream carried no message");
  return JSON.parse(message);
}
