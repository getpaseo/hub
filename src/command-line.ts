import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import type { RuntimeEnvironmentSource } from "./runtime-environment.js";

export interface HubLaunch {
  environmentSource: RuntimeEnvironmentSource;
}

export function readHubCommandLine(argv: readonly string[] = process.argv): HubLaunch {
  const { values } = parseArgs({
    args: argv.slice(2),
    options: {
      "no-env": { type: "boolean" },
    },
    strict: false,
    allowPositionals: true,
  });

  return {
    environmentSource: values["no-env"] === true ? "process-only" : "process-and-dotenv",
  };
}

export function isCommandLineEntrypoint(
  moduleUrl: string,
  argv: readonly string[] = process.argv,
): boolean {
  const entrypoint = argv[1];
  return entrypoint !== undefined && entrypoint === fileURLToPath(moduleUrl);
}
