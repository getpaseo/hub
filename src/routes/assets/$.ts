import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createFileRoute } from "@tanstack/react-router";

const ASSET_NAME = /^[A-Za-z0-9._-]+$/u;

export const Route = createFileRoute("/assets/$")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const name = new URL(request.url).pathname.slice("/assets/".length);
        if (!ASSET_NAME.test(name)) return new Response("Not Found", { status: 404 });
        try {
          const body = await readFile(join(process.cwd(), ".output/client/assets", name));
          return new Response(body, {
            headers: {
              "cache-control": "public, max-age=31536000, immutable",
              "content-type": contentType(name),
            },
          });
        } catch {
          return new Response("Not Found", { status: 404 });
        }
      },
    },
  },
});

function contentType(name: string): string {
  if (name.endsWith(".css")) return "text/css; charset=utf-8";
  if (name.endsWith(".js")) return "text/javascript; charset=utf-8";
  return "application/octet-stream";
}
