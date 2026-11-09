import type { ProviderRegistration } from "./registration.js";

/** The provider retains its native type; the lifecycle owner only holds the shared registration. */
export class ProviderRuntimeDefinition<Registration extends ProviderRegistration> {
  private readonly instances = new WeakMap<ProviderRegistration, Registration>();

  constructor(
    readonly provider: string,
    private readonly accepts: (registration: ProviderRegistration) => registration is Registration,
  ) {}

  register(registration: Registration): Registration {
    this.instances.set(registration, registration);
    return registration;
  }

  find(registration: ProviderRegistration): Registration | undefined {
    if (registration.connection.name !== this.provider) return undefined;
    return this.require(registration);
  }

  require(registration: ProviderRegistration): Registration {
    const instance = this.instances.get(registration);
    if (instance !== undefined) return instance;
    if (!this.accepts(registration))
      throw new Error(`invalid runtime capability: ${this.provider}`);
    // A host and its loaded server bundle may hold separate copies of the definition.
    // Validate that boundary structurally, then retain the provider's type for this copy.
    this.instances.set(registration, registration);
    return registration;
  }
}

export interface ActiveProviderRuntime {
  read<Registration extends ProviderRegistration, Value>(
    definition: ProviderRuntimeDefinition<Registration>,
    operation: (registration: Registration | undefined) => Value,
  ): Value;
  use<Registration extends ProviderRegistration, Value>(
    definition: ProviderRuntimeDefinition<Registration>,
    operation: (registration: Registration | undefined) => Promise<Value>,
  ): Promise<Value>;
}

/** A fixed composition has no replacements to drain; consumers still use the same lease interface. */
export function staticProviderRuntime(
  registrations: readonly ProviderRegistration[],
): ActiveProviderRuntime {
  return {
    read(definition, operation) {
      const registration = registrations
        .map((item) => definition.find(item))
        .find((item) => item !== undefined);
      return operation(registration);
    },
    async use(definition, operation) {
      const registration = registrations
        .map((item) => definition.find(item))
        .find((item) => item !== undefined);
      return operation(registration);
    },
  };
}
