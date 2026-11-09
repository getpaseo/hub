import { browserProvider, browserProviders } from "../providers/browser.js";
import type { GuideField, GuideGroup, ProviderGuide, Tone } from "../providers/presentation.js";
import type {
  Provider,
  ProviderApplicationIdentity,
  ProviderApplicationOverview,
  ProviderApplicationStatus,
  ProviderApplicationView,
} from "./index.js";
export { guideUrl, isSecureOrigin } from "../providers/presentation.js";
export type {
  GuideField,
  GuideGroup,
  GuideStep,
  GuideUrl,
  ProviderGuide,
  StepSegment,
} from "../providers/presentation.js";
export const PROVIDER_GUIDES: readonly ProviderGuide[] = browserProviders.map(
  (provider) => provider.guide,
);
export function guideFor(provider: Provider): ProviderGuide {
  const module = browserProviders.find((candidate) => candidate.id === provider);
  if (module === undefined) throw new Error(`unknown provider: ${provider}`);
  return module.guide;
}
export function guideGroups(guide: ProviderGuide, origin: string): readonly GuideGroup[] {
  return guide.groups.map((group) => {
    const unavailable = group.unavailableAt?.(origin);
    const { unavailableAt: _ignored, ...rest } = group;
    return unavailable === undefined ? rest : { ...rest, unavailable, steps: [], fields: [] };
  });
}

/** Every value the operator can submit from this origin, in the order the groups ask for them. */
export function guideFields(guide: ProviderGuide, origin: string): readonly GuideField[] {
  return guideGroups(guide, origin).flatMap((group) => group.fields);
}

const STATUS_LABELS: Record<ProviderApplicationStatus, { label: string; tone: Tone }> = {
  notConfigured: { label: "Not set up", tone: "neutral" },
  // Neutral on purpose. Credentials a provider accepted are not a working integration, and the
  // success tone is reserved for a connection that actually exists.
  verified: { label: "Verified", tone: "neutral" },
  connected: { label: "Connected", tone: "success" },
  actionNeeded: { label: "Action needed", tone: "warning" },
  managedByEnvironment: { label: "Managed by environment", tone: "neutral" },
};

export function statusPresentation(status: ProviderApplicationStatus): {
  label: string;
  tone: Tone;
} {
  return STATUS_LABELS[status];
}

export function identityLabel(identity: ProviderApplicationIdentity): string {
  return browserProvider(identity.provider).identityLabel(identity);
}

export function providerApplicationView(
  overview: ProviderApplicationOverview,
  provider: string,
): ProviderApplicationView {
  const view = overview.providers[provider];
  if (view === undefined) throw new Error(`provider application view unavailable: ${provider}`);
  return view;
}
