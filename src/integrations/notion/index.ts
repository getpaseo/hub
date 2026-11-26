import { defineIntegration } from "../contracts.js";
import { notionConnectionCapability } from "./internal/auth.js";
import { notionToolsCapability } from "./internal/tools.js";

/**
 * Notion integration definition (PR 2: Internal Connection + Public OAuth + 5 scoped MCP tools).
 */
export const notionIntegration = defineIntegration({
  id: "notion",
  label: "Notion",
  resourceNoun: "Data source",
  connection: notionConnectionCapability,
  tools: notionToolsCapability,
});
