import { formatDuration } from "../../config/duration-format.js";
import type { ProviderStepConfiguration } from "../configuration.js";
import {
  AuthoredGitHubAuthoritySchema,
  CompiledGitHubAuthoritySchema,
  compileGitHubAuthority,
  isGitHubAuthorityEnvironmentKey,
  validateGitHubAuthority,
} from "./authority-configuration.js";

export const stepConfiguration: ProviderStepConfiguration = {
  key: "github",
  authoredSchema: AuthoredGitHubAuthoritySchema.optional(),
  compiledSchema: CompiledGitHubAuthoritySchema.optional(),
  compile(value, context) {
    return compileGitHubAuthority(
      AuthoredGitHubAuthoritySchema.parse(value),
      `trigger ${context.triggerName} step ${context.stepId} github`,
    );
  },
  validateEnvironmentKey(key, context) {
    if (isGitHubAuthorityEnvironmentKey(key))
      throw new Error(
        `trigger ${context.triggerName} step ${context.stepId} env.${key}: reserved by the step-level github authority; remove it from env`,
      );
  },
  validate(value, context) {
    const github = CompiledGitHubAuthoritySchema.parse(value);
    const path = `trigger ${context.triggerName} step ${context.stepId}`;
    validateGitHubAuthority(github, `${path} github`);
    if (github.repositories === undefined && !context.event.startsWith("github."))
      throw new Error(
        `${path} github.repositories is required for non-GitHub triggers; list the repositories explicitly`,
      );
  },
  decompile(value) {
    const github = CompiledGitHubAuthoritySchema.parse(value);
    return {
      connection: github.connection,
      ...(github.repositories === undefined ? {} : { repositories: [...github.repositories] }),
      permissions: { ...github.permissions },
      duration: formatDuration(github.durationMs),
    };
  },
  compatibility(value) {
    return value ?? null;
  },
  executionAuthority: { unavailable: () => new Error("GitHub step authority is unavailable") },
};
