import { ApiReferenceReact, type AnyApiReferenceConfiguration } from "@scalar/api-reference-react";
// @ts-expect-error Vite resolves the package-exported CSS as inline text at build time.
import scalarStyles from "@scalar/api-reference-react/style.css?inline";

/**
 * Scalar ships its own theme. Rather than re-declaring the design system in a string, this maps
 * Scalar's variables onto the app's tokens, so the reference inherits the shell's palette, type,
 * and radii and follows them whenever `styles.css` changes.
 *
 * Scalar sets its palette on `.light-mode` / `.dark-mode` — in this layout, `<body>` — and derives
 * a second tier of variables from it on the same element (`--scalar-sidebar-background-1` reads
 * `--scalar-background-1`). The override therefore has to land on those classes, not only on
 * `.scalar-app`: a value set lower down arrives too late for the tier that was already resolved
 * above it, which is what leaves a white sidebar beside a dark page.
 *
 * Weights come from Scalar's own weight tokens — all but a handful of its `font-weight`
 * declarations read `--scalar-semibold` or `--scalar-bold` — so nothing here overrides
 * `font-weight` per element. Every one of them is mapped, including the sidebar's and the
 * links', so a surface this configuration does not show today cannot arrive at 600 later.
 */
const referenceTheme = `
:root,
.light-mode,
.dark-mode,
.scalar-app {
  --scalar-font: var(--font-sans);
  --scalar-font-code: var(--font-mono);

  --scalar-background-1: var(--background);
  --scalar-background-2: var(--card);
  --scalar-background-3: var(--accent);
  --scalar-background-accent: var(--accent);
  --scalar-color-1: var(--foreground);
  --scalar-color-2: var(--muted-foreground);
  --scalar-color-3: var(--extra-muted-foreground);
  --scalar-color-accent: var(--link);
  --scalar-link-color: var(--link);
  --scalar-link-color-hover: var(--link);
  --scalar-border-color: var(--border);

  --scalar-radius: var(--radius-md);
  --scalar-radius-lg: var(--radius-lg);
  --scalar-radius-xl: var(--radius-xl);

  --scalar-regular: var(--font-weight-normal);
  --scalar-semibold: var(--font-weight-normal);
  --scalar-bold: var(--font-weight-title);
  --scalar-sidebar-font-weight: var(--font-weight-normal);
  --scalar-link-font-weight: var(--font-weight-normal);
  --scalar-font-normal: 400;
  --scalar-font-medium: 400;
  --scalar-font-bold: var(--font-weight-title);
}
.scalar-app { font-weight: 400; }
`;
const referenceConfiguration = {
  url: "/api/openapi.json",
  metaData: { title: "Paseo Hub Public API" },
  theme: "default",
  layout: "modern",
  showSidebar: true,
  // The app renders dark only, and both Scalar modes now resolve to the same tokens, so the
  // toggle would be a control that changes nothing.
  forceDarkModeState: "dark",
  hideDarkModeToggle: true,
  hideModels: false,
  hideClientButton: true,
  hideTestRequestButton: true,
  persistAuth: false,
  telemetry: false,
  withDefaultFonts: false,
  agent: { disabled: true },
  mcp: { disabled: true },
  externalUrls: {
    dashboardUrl: "/api/reference",
    registryUrl: "/api/openapi.json",
    proxyUrl: "/api/reference",
    apiBaseUrl: "/api/reference",
  },
  customCss: `${scalarStyles}\n${referenceTheme}`,
} satisfies AnyApiReferenceConfiguration;

export function PublicApiReference() {
  return (
    <main aria-label="Paseo Hub API reference" className="min-h-screen">
      <ApiReferenceReact configuration={referenceConfiguration} />
    </main>
  );
}
