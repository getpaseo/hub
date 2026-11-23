import type { Page } from "@playwright/test";
import { ProjectNavigation } from "./navigation.js";
import { ProjectLifecycle } from "./projects.js";

export function projectApp(page: Page) {
  return {
    navigation: new ProjectNavigation(page),
    projects: new ProjectLifecycle(page),
  };
}
