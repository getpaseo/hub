import { createStartHandler, defaultStreamHandler } from "@tanstack/react-start/server";
import { startProductionRuntime } from "./index.js";
import { hasApplication, startApplication } from "./server/runtime.js";
export { handleDaemonUpgrade, startProductionRuntime, stopProductionRuntime } from "./index.js";
export { startApplication } from "./server/runtime.js";

const startFetch = createStartHandler(defaultStreamHandler);

const fetch = async (request: Request) => {
  if (!hasApplication()) await startProductionRuntime();
  return startFetch(request);
};

export default { fetch };
