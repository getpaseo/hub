import type { AuthServer } from "../auth/server.js";
import type { Database } from "../db/types.js";
import { resolveRouteTenant } from "../projects/access.js";
import type { HubProviderSnapshot } from "../hub/protocol.js";
import type { DaemonConnection } from "./protocol.js";

export class DaemonProviderCatalog {
  constructor(
    private readonly database: Database,
    private readonly auth: AuthServer,
    private readonly connectionForDaemon: (daemonId: string) => DaemonConnection | undefined,
  ) {}

  async read(
    request: Request,
    input: {
      organizationSlug: string;
      daemonId: string;
      cwd?: string;
      refresh?: boolean;
    },
  ): Promise<HubProviderSnapshot> {
    const { tenant } = await resolveRouteTenant(this.auth, this.database, request, {
      organizationSlug: input.organizationSlug,
    });
    const daemon = await this.database.findDaemonForOrganization(
      tenant.organization.id,
      input.daemonId,
    );
    if (daemon?.status !== "active") throw new Error("daemon_unavailable");
    const connection = this.connectionForDaemon(daemon.id);
    if (connection === undefined) throw new Error("daemon_not_connected");
    const scope = input.cwd === undefined ? {} : { cwd: input.cwd };
    if (input.refresh === true) await connection.refreshProviderSnapshot(scope);
    return await connection.getProviderSnapshot(scope);
  }
}
