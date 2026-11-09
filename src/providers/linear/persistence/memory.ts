import type { MemoryProviderContext } from "../../../db/provider-persistence.js";
import type {
  AcceptLinearEventInput,
  BindLinearConnectionInput,
  CompleteLinearProviderApplicationInput,
  ConnectionStartAuthority,
  LinearConnectionRecord,
  LinearConnectionRefreshOperation,
  ProviderEventAcceptance,
  UpdateLinearConnectionTokensInput,
} from "../../../db/types.js";
import { linearConnectionRequiresReauthorization } from "../../linear/client.js";
export class LinearMemoryPersistence {
  private readonly linearConnections = new Map<string, LinearConnectionRecord>();
  constructor(private readonly context: MemoryProviderContext) {}
  async acceptLinearEvent(input: AcceptLinearEventInput): Promise<ProviderEventAcceptance> {
    const binding = await this.findLinearConnection(input.linearOrganizationId);
    const reason = linearDropReason(input, binding);
    return this.context.accept(
      "linear",
      input,
      binding?.organizationId,
      binding?.id,
      input.projectId ?? null,
      reason,
    );
  }
  bindLinearConnection(_input: BindLinearConnectionInput): Promise<void> {
    return connectionPersistenceUnavailable();
  }
  completeLinearProviderApplication(_input: CompleteLinearProviderApplicationInput): Promise<void> {
    return connectionPersistenceUnavailable();
  }
  updateLinearConnectionTokens(_input: UpdateLinearConnectionTokensInput): Promise<void> {
    return connectionPersistenceUnavailable();
  }
  withLinearConnectionRefresh<T>(
    linearOrganizationId: string,
    operation: LinearConnectionRefreshOperation<T>,
  ): Promise<T> {
    return this.context.withLock(
      JSON.stringify(["paseo-connection", "linear", "external", linearOrganizationId]),
      async () => {
        const connection = this.linearConnections.get(linearOrganizationId);
        return operation(connection, async (input) => {
          const current = this.linearConnections.get(linearOrganizationId);
          if (current === undefined) throw new Error("Linear connection unavailable");
          this.linearConnections.set(linearOrganizationId, { ...current, ...input });
        });
      },
    );
  }
  findLinearConnection(_linearOrganizationId: string): Promise<LinearConnectionRecord | undefined> {
    return Promise.resolve(this.linearConnections.get(_linearOrganizationId));
  }
  findLinearConnectionForOrganization(
    organizationId: string,
    linearOrganizationId: string,
  ): Promise<LinearConnectionRecord | undefined> {
    const connection = this.linearConnections.get(linearOrganizationId);
    return Promise.resolve(connection?.organizationId === organizationId ? connection : undefined);
  }
  async listConnections(organizationId?: string) {
    return Array.from(this.linearConnections.values()).filter(
      (connection) => organizationId === undefined || connection.organizationId === organizationId,
    );
  }
  disconnectConnection(_connectionId: string, _access: ConnectionStartAuthority): never {
    return connectionPersistenceUnavailable();
  }
}
function linearDropReason(
  input: AcceptLinearEventInput,
  binding: LinearConnectionRecord | undefined,
): string | undefined {
  if (input.dropReason !== undefined) return input.dropReason;
  if (binding === undefined) return "linear_unbound";
  if (linearConnectionRequiresReauthorization(binding, input.receivedAt)) {
    return "configuration_unavailable";
  }
  return undefined;
}
function connectionPersistenceUnavailable(): never {
  throw new Error("connection persistence requires PostgreSQL");
}
export function linearMemoryPersistence(context: MemoryProviderContext) {
  return new LinearMemoryPersistence(context);
}
