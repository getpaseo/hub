import { writeFile } from "node:fs/promises";
import path from "node:path";
import { relevantHeaders, resignHeaders, scrubText } from "./forgejo-capture-scrub.mjs";

export function fixtureWriter(fixturesDir, apiFixturesDir, forgejoOrigin) {
  return {
    async saveDelivery(name, delivery) {
      const scrubbedBody = scrubText(delivery.body, forgejoOrigin);
      const headers = resignHeaders(relevantHeaders(delivery.headers), scrubbedBody);
      const fixture = { headers, body: scrubbedBody };
      await writeFile(
        path.join(fixturesDir, `${name}.json`),
        `${JSON.stringify(fixture, null, 2)}\n`,
      );
    },
    /** `body` is the already-JSON-parsed API response; re-stringified here, indented. */
    async saveApiFixture(name, body) {
      const scrubbed = scrubText(JSON.stringify(body, null, 2), forgejoOrigin);
      await writeFile(path.join(apiFixturesDir, `${name}.json`), `${scrubbed}\n`);
    },
  };
}
