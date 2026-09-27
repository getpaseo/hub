import http from "node:http";

/**
 * Collects raw webhook deliveries the container sends back over
 * `host.containers.internal`. Polling-with-timeout, not a fixed sleep: Forgejo delivers
 * asynchronously off a queue, so the wait time genuinely varies.
 */
export function startCaptureListener(port) {
  const deliveries = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const headers = {};
      for (const [key, value] of Object.entries(req.headers)) headers[key.toLowerCase()] = value;
      deliveries.push({ headers, body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(200);
      res.end("ok");
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => {
      resolve({
        deliveries,
        close: () => new Promise((r) => server.close(() => r(undefined))),
        /** Wait for the delivery at `index` (0-based, in arrival order) to show up. */
        async waitFor(index, timeoutMs = 20_000) {
          const deadline = Date.now() + timeoutMs;
          while (Date.now() < deadline) {
            if (deliveries.length > index) return deliveries[index];
            await new Promise((r) => setTimeout(r, 200));
          }
          throw new Error(
            `timed out waiting for delivery #${index}; only ${deliveries.length} arrived`,
          );
        },
      });
    });
  });
}
