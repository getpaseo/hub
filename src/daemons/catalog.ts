import type { AuthServer } from "../auth/server.js";
import type { Database } from "../db/types.js";
import { resolveRouteTenant } from "../projects/access.js";
import type {
  HubProviderControls,
  HubProviderControlsDraftConfig,
  HubProviderSnapshot,
} from "../hub/protocol.js";
import type { DaemonConnection, DaemonProject } from "./protocol.js";

const UNAVAILABLE_PROVIDER_CONTROLS: HubProviderControls = {
  available: false,
  controls: [],
  options: {},
};

interface DaemonScope {
  organizationSlug: string;
  daemonId: string;
}

/**
 * What one of an organization's daemons offers a trigger author: the agents it can run and the
 * projects it has open. Every read is authorized against the organization that owns the daemon.
 */
export class DaemonCatalog {
  constructor(
    private readonly database: Database,
    private readonly auth: AuthServer,
    private readonly connectionForDaemon: (daemonId: string) => DaemonConnection | undefined,
  ) {}

  async providers(
    request: Request,
    input: DaemonScope & { cwd?: string; refresh?: boolean },
  ): Promise<HubProviderSnapshot> {
    const connection = await this.connection(request, input);
    if (connection === undefined) throw new Error("daemon_not_connected");
    const scope = input.cwd === undefined ? {} : { cwd: input.cwd };
    if (input.refresh === true) await connection.refreshProviderSnapshot(scope);
    return await connection.getProviderSnapshot(scope);
  }

  /** Projects are suggestions for a path the author can always type, so an offline daemon has none. */
  async projects(request: Request, input: DaemonScope): Promise<readonly DaemonProject[]> {
    const connection = await this.connection(request, input);
    return connection === undefined ? [] : await connection.listProjects();
  }

  /** Provider option controls are daemon-driven; an offline daemon offers none. */
  async providerControls(
    request: Request,
    input: DaemonScope & HubProviderControlsDraftConfig,
  ): Promise<HubProviderControls> {
    const connection = await this.connection(request, input);
    if (connection === undefined) return UNAVAILABLE_PROVIDER_CONTROLS;
    return await connection.listProviderControls({
      provider: input.provider,
      cwd: input.cwd,
      ...(input.modeId === undefined ? {} : { modeId: input.modeId }),
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.thinkingOptionId === undefined ? {} : { thinkingOptionId: input.thinkingOptionId }),
      ...(input.providerOptions === undefined ? {} : { providerOptions: input.providerOptions }),
    });
  }

  private async connection(
    request: Request,
    input: DaemonScope,
  ): Promise<DaemonConnection | undefined> {
    const { tenant } = await resolveRouteTenant(this.auth, this.database, request, {
      organizationSlug: input.organizationSlug,
    });
    const daemon = await this.database.findDaemonForOrganization(
      tenant.organization.id,
      input.daemonId,
    );
    if (daemon?.status !== "active") throw new Error("daemon_unavailable");
    return this.connectionForDaemon(daemon.id);
  }
}
