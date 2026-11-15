import { createHash } from "node:crypto";
import { z } from "zod";
import type { AuthServer } from "../../auth/server.js";
import type { GitHubConfigurationProvider } from "../../configuration/github-sync.js";
import type {
  ConnectionAccountAccess,
  ConnectionAttemptPhase,
  ConnectionAttemptRecord,
  Database,
  GitHubConnectionAttemptStep,
  GitHubConnectionRecord,
} from "../../db/types.js";
import {
  CONNECTION_ATTEMPT_LIFETIME_MINUTES,
  INTEGRATIONS_RETURN_ROUTE,
  callbackConnectionAccess,
  cancelledConnectionResult,
  connectionAccess,
  connectionActionFailure,
  connectionCallbackFailure,
  connectionResult,
  manageConnectionAccess,
  newConnectionState,
  positiveInteger,
  requiredConnectionId,
  stateHash,
} from "../../connections/shared.js";
import type { ProviderConnectionRegistration } from "../registration.js";
import type { GitHubRegistrationConfiguration } from "./index.js";
import type {
  GitHubConnectionClient,
  GitHubInstallationIdentity,
  GitHubUserInstallation,
} from "./client.js";

/**
 * Connecting GitHub. One button starts it, and the person's only decision is which account.
 *
 * Every attempt starts by authorizing the person on GitHub, because only their token says which
 * installations they can see and which accounts they own. The callback then sends them where
 * the answer leads: straight back connected when they just installed on an account they own, to
 * Hub's chooser when the App is already installed somewhere they can see, or to GitHub's install
 * page when it is installed nowhere. GitHub never calls back for an account that already has
 * the App, so the chooser is the only way such an account can be connected.
 *
 * The chooser only offers what this attempt verified. The choices are stored on the attempt, so a
 * chosen installation that is not among them, or not connectable, binds nothing.
 */
export const GITHUB_CONNECTION_ACTIONS = [
  "start",
  "disconnect",
  "setup",
  "callback",
  "choices",
  "choose",
  "addAccount",
] as const;

export type GitHubAccountAvailability = z.infer<typeof availabilitySchema>;
export type GitHubAccountChoice = z.infer<typeof choiceSchema>;

export interface GitHubAccountChooser {
  returnRoute: string;
  choices: readonly GitHubAccountChoice[];
}

/** Where Hub's chooser lives. Its only input is the attempt's state. */
export const GITHUB_CHOOSER_ROUTE = "/integrations/github";

const availabilitySchema = z.enum([
  "available",
  /** Connected to the organization this attempt is for. Nothing to do. */
  "connected",
  /** Connected to another Hub organization. Never transferred from here. */
  "connectedElsewhere",
  "notOwner",
]);
const choiceSchema = z.object({
  installationId: z.number().int().positive(),
  accountId: z.string(),
  accountLogin: z.string(),
  accountType: z.string(),
  status: z.enum(["active", "suspended"]),
  availability: availabilitySchema,
});
const choicesSchema = z.array(choiceSchema).min(1);

export interface GitHubConnectionOptions {
  database: Database;
  auth: AuthServer;
  applicationBaseUrl: string;
  callbackOrigin: string;
  configurationVersion: number;
  configuration: GitHubRegistrationConfiguration;
}

export interface GitHubConnectionServices {
  client: GitHubConnectionClient;
  repositories: Pick<GitHubConfigurationProvider, "listInstallationRepositories">;
}

export function githubConnectionStatus(configured: boolean): ProviderConnectionRegistration {
  return {
    name: "github",
    status: (connections) => githubStatus(configured, connections.github),
    actions: {},
  };
}

export function createGitHubConnection(
  options: GitHubConnectionOptions,
  services: GitHubConnectionServices | undefined,
): ProviderConnectionRegistration {
  const flow = services === undefined ? undefined : new GitHubConnectionFlow(options, services);
  const notConfigured = (request: Request, phase: string) =>
    Promise.resolve(
      connectionCallbackFailure({
        request,
        error: new GitHubCallbackError("github is not configured"),
        provider: "github",
        phase,
        applicationBaseUrl: options.applicationBaseUrl,
        returnRoute: INTEGRATIONS_RETURN_ROUTE,
      }),
    );
  return {
    name: "github",
    status: (connections) => githubStatus(flow !== undefined, connections.github),
    actions: {
      start: async (request) => {
        const rejected = options.auth.rejectCookieMutation(request);
        if (rejected !== undefined) return rejected;
        if (flow === undefined) {
          return Response.json({ error: "provider_not_configured" }, { status: 409 });
        }
        return flow.start(request);
      },
      disconnect: (request) => disconnect(options, request),
      setup: (request) => flow?.setup(request) ?? notConfigured(request, "setup"),
      callback: (request) => flow?.callback(request) ?? notConfigured(request, "authorization"),
      choices: (request) => flow?.choices(request) ?? notConfigured(request, "choices"),
      choose: (request) => {
        const rejected = options.auth.rejectCookieMutation(request);
        if (rejected !== undefined) return Promise.resolve(rejected);
        return flow?.choose(request) ?? notConfigured(request, "choose");
      },
      addAccount: (request) => {
        const rejected = options.auth.rejectCookieMutation(request);
        if (rejected !== undefined) return Promise.resolve(rejected);
        return flow?.addAccount(request) ?? notConfigured(request, "addAccount");
      },
    },
  };
}

async function disconnect(options: GitHubConnectionOptions, request: Request): Promise<Response> {
  const rejected = options.auth.rejectCookieMutation(request);
  if (rejected !== undefined) return rejected;
  try {
    const access = await manageConnectionAccess(options.auth, options.database, request);
    await options.database.disconnectConnection(
      "github",
      requiredConnectionId(request),
      connectionAccess(access),
    );
    return Response.json({ disconnected: true });
  } catch (error) {
    return connectionActionFailure(error, "github", "disconnect");
  }
}

/** One step of an attempt, read under the session that started it. */
interface AttemptStep {
  state: string;
  phase: ConnectionAttemptPhase;
  access: ConnectionAccountAccess;
  attempt: ConnectionAttemptRecord;
}

class GitHubConnectionFlow {
  constructor(
    private readonly options: GitHubConnectionOptions,
    private readonly services: GitHubConnectionServices,
  ) {}

  private get database(): Database {
    return this.options.database;
  }

  async start(request: Request): Promise<Response> {
    try {
      const access = await manageConnectionAccess(this.options.auth, this.database, request);
      const state = newConnectionState();
      const verifier = newConnectionState();
      await this.database.startConnectionAttempt({
        provider: "github",
        stateVerifier: stateHash(state),
        pkceVerifier: verifier,
        access: connectionAccess(access),
        lifetimeMinutes: CONNECTION_ATTEMPT_LIFETIME_MINUTES,
        callbackOrigin: this.options.callbackOrigin,
        configurationVersion: this.options.configurationVersion,
        providerApplicationId: this.options.configuration.appId,
        configurationSnapshot: { provider: "github", ...this.options.configuration },
        expectedConfigurationVersion: null,
        activateConfiguration: false,
      });
      return Response.json({
        url: this.services.client.authorizationUrl({ state, challenge: pkceChallenge(verifier) }),
      });
    } catch (error) {
      return connectionActionFailure(error, "github", "start");
    }
  }

  /** GitHub's return from its install page. */
  setup(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const installationId = positiveInteger(url.searchParams.get("installation_id"));
    const action = url.searchParams.get("setup_action");
    return this.step(request, "github_setup", "setup", async (step) => {
      if (action === "request") {
        await this.consume(step);
        return this.result(step, "github_approval_required");
      }
      if ((action !== "install" && action !== "update") || installationId === undefined) {
        throw new GitHubCallbackError("invalid setup result");
      }
      return this.authorize(step, installationId);
    });
  }

  /** GitHub's return from its authorize page. */
  callback(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    if (state !== null && code === null && url.searchParams.get("error") === "access_denied") {
      return cancelledConnectionResult({
        auth: this.options.auth,
        database: this.database,
        request,
        provider: "github",
        phase: "github_user_authorization",
        state,
        applicationBaseUrl: this.options.applicationBaseUrl,
      });
    }
    return this.step(request, "github_user_authorization", "authorization", async (step) => {
      if (code === null || step.attempt.pkceVerifier === null) {
        throw new GitHubCallbackError("invalid authorization callback");
      }
      const installations = await this.services.client.userInstallations({
        code,
        verifier: step.attempt.pkceVerifier,
      });
      if (installations === undefined) {
        await this.consume(step);
        return this.result(step, "github_verification_rejected");
      }
      const choices = await this.choicesFor(installations, step.attempt.organizationId);
      const installed = positiveInteger(step.attempt.candidateExternalId);
      if (installed !== undefined) {
        const justInstalled = choices.find((choice) => choice.installationId === installed);
        if (justInstalled?.availability === "available") return this.connect(step, justInstalled);
        // GitHub's setup return named an installation this person cannot see, or does not own.
        if (justInstalled === undefined || justInstalled.availability === "notOwner") {
          await this.consume(step);
          return this.result(step, "github_verification_rejected");
        }
      }
      if (choices.length > 0) return this.offer(step, choices);
      return this.install(step);
    });
  }

  /** What the chooser shows. Answers JSON, or a redirect when the attempt is gone. */
  choices(request: Request): Promise<Response> {
    return this.step(request, "github_selection", "choices", (step) => {
      const chooser: GitHubAccountChooser = {
        returnRoute: step.attempt.returnRoute,
        choices: storedChoices(step.attempt),
      };
      return Promise.resolve(Response.json(chooser));
    });
  }

  choose(request: Request): Promise<Response> {
    const installationId = positiveInteger(new URL(request.url).searchParams.get("installationId"));
    return this.step(request, "github_selection", "choose", async (step) => {
      const choice = storedChoices(step.attempt).find(
        (candidate) =>
          candidate.installationId === installationId && candidate.availability === "available",
      );
      if (choice === undefined) {
        await this.consume(step);
        return this.result(step, "github_verification_rejected");
      }
      return this.connect(step, choice);
    });
  }

  addAccount(request: Request): Promise<Response> {
    return this.step(request, "github_selection", "addAccount", (step) => this.install(step));
  }

  /**
   * Reads the attempt this request continues and runs one step of it. Any failure, including an
   * attempt that is gone, sends the browser back to where the connection started.
   */
  private async step(
    request: Request,
    phase: ConnectionAttemptPhase,
    label: string,
    run: (step: AttemptStep) => Promise<Response>,
  ): Promise<Response> {
    const state = new URL(request.url).searchParams.get("state");
    let returnRoute: string = INTEGRATIONS_RETURN_ROUTE;
    let callbackOrigin = this.options.applicationBaseUrl;
    try {
      if (state === null) throw new GitHubCallbackError("missing state");
      const access = await callbackConnectionAccess(this.options.auth, request);
      const attempt = await this.database.readConnectionAttempt({
        stateVerifier: stateHash(state),
        phase,
        access,
      });
      returnRoute = attempt.returnRoute;
      callbackOrigin = attempt.callbackOrigin;
      return await run({ state, phase, access, attempt });
    } catch (error) {
      return connectionCallbackFailure({
        request,
        error,
        provider: "github",
        phase: label,
        applicationBaseUrl: callbackOrigin,
        returnRoute,
      });
    }
  }

  private async choicesFor(
    installations: readonly GitHubUserInstallation[],
    organizationId: string,
  ): Promise<GitHubAccountChoice[]> {
    return Promise.all(
      installations.map(async ({ identity, ownership }) => {
        const connection = await this.database.findGitHubConnection(identity.installationId);
        return {
          ...identity,
          availability: availabilityOf(ownership.status, connection, organizationId),
        };
      }),
    );
  }

  private async connect(step: AttemptStep, choice: GitHubAccountChoice): Promise<Response> {
    const identity: GitHubInstallationIdentity = {
      installationId: choice.installationId,
      accountId: choice.accountId,
      accountLogin: choice.accountLogin,
      accountType: choice.accountType,
      status: choice.status,
    };
    await this.database.synchronizeGitHubInstallation(identity.installationId, async () => {
      const repositories =
        identity.status === "suspended"
          ? []
          : await this.services.repositories.listInstallationRepositories({
              installationId: identity.installationId,
            });
      await this.database.bindGitHubConnection({
        providerApplicationId: this.options.configuration.appId,
        repositories,
        stateVerifier: stateHash(step.state),
        phase: step.phase,
        access: step.access,
        ...identity,
      });
    });
    return this.result(step, "github_connected");
  }

  private async offer(step: AttemptStep, choices: GitHubAccountChoice[]): Promise<Response> {
    const state = await this.advance(step, {
      phase: "github_selection",
      installationChoices: choices,
    });
    const chooser = new URL(GITHUB_CHOOSER_ROUTE, step.attempt.callbackOrigin);
    chooser.searchParams.set("state", state);
    return Response.redirect(chooser, 303);
  }

  private async install(step: AttemptStep): Promise<Response> {
    const state = await this.advance(step, { phase: "github_setup" });
    return Response.redirect(this.services.client.installationUrl(state), 303);
  }

  private async authorize(step: AttemptStep, installationId: number): Promise<Response> {
    const verifier = newConnectionState();
    const state = await this.advance(step, {
      phase: "github_user_authorization",
      installationId,
      pkceVerifier: verifier,
    });
    return Response.redirect(
      this.services.client.authorizationUrl({ state, challenge: pkceChallenge(verifier) }),
      303,
    );
  }

  /** Moves the attempt on and returns the state that continues it. */
  private async advance(step: AttemptStep, next: GitHubConnectionAttemptStep): Promise<string> {
    const state = newConnectionState();
    await this.database.advanceGitHubConnectionAttempt({
      stateVerifier: stateHash(step.state),
      phase: step.phase,
      access: step.access,
      nextStateVerifier: stateHash(state),
      next,
    });
    return state;
  }

  private consume(step: AttemptStep): Promise<void> {
    return this.database.consumeConnectionAttempt({
      stateVerifier: stateHash(step.state),
      phase: step.phase,
      access: step.access,
    });
  }

  private result(
    step: AttemptStep,
    result: "github_connected" | "github_approval_required" | "github_verification_rejected",
  ): Response {
    return connectionResult(
      step.attempt.callbackOrigin,
      step.attempt.returnRoute,
      result,
      "github",
    );
  }
}

function availabilityOf(
  ownership: GitHubUserInstallation["ownership"]["status"],
  connection: GitHubConnectionRecord | undefined,
  organizationId: string,
): GitHubAccountAvailability {
  if (connection !== undefined) {
    return connection.organizationId === organizationId ? "connected" : "connectedElsewhere";
  }
  return ownership === "owner" ? "available" : "notOwner";
}

function storedChoices(attempt: ConnectionAttemptRecord): GitHubAccountChoice[] {
  return choicesSchema.parse(attempt.installationChoices);
}

class GitHubCallbackError extends Error {
  readonly code = "invalidInput";
}

function githubStatus(configured: boolean, bindings: readonly GitHubConnectionRecord[]) {
  if (!configured) return { status: "notConfigured" as const };
  if (bindings.length === 0) return { status: "disconnected" as const };
  return bindings.every((binding) => binding.status === "suspended")
    ? { status: "suspended" as const }
    : { status: "connected" as const };
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}
