/* oxlint-disable typescript-eslint/no-unsafe-type-assertion -- dynamic tenant URLs are assembled from server-resolved route metadata */
import { Check, FolderKanban, LogOut, Plus, ShieldCheck } from "lucide-react";
import { Link, useRouterState } from "@tanstack/react-router";
import { useCallback, useState, type FormEvent } from "react";

import { PaseoGlyph } from "../components/app/auth-layout.js";
import { FormDialog } from "../components/app/form-dialog.js";
import { FormField } from "../components/app/form-field.js";
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "../components/ui/dropdown-menu.js";
import { useSidebar } from "../components/ui/sidebar.js";
import { formValue } from "../auth/account-actions.js";
import type { ActiveAccountState } from "../auth/organization-contract.js";
import type { useOptionalRouteTenant } from "../projects/context.js";
import { SidebarSwitcher } from "./sidebar-switcher.js";
import { routeSection } from "./site-header.js";

/** The organization, project, and membership behind the URL, once the shell has resolved it. */
export type RouteTenant = NonNullable<ReturnType<typeof useOptionalRouteTenant>>;

/** Where the instance surfaces begin, for the one link into them that is not in a nav group. */
const INSTANCE_ENTRY = "/apps";

const ORGANIZATION_MARK = <PaseoGlyph />;
const PROJECT_MARK = <FolderKanban aria-hidden="true" />;

const ROLE_LABELS: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
};

/**
 * Switching organization is a choice, not a form submission — picking a membership
 * applies it. Creating one is the low-frequency action at the bottom of the same menu.
 */
export function OrganizationSwitcher({
  account,
  organization,
  role,
  busy,
  onCreateOrganization,
  onSelectOrganization,
}: {
  account: ActiveAccountState;
  organization: { id: string; name: string };
  role: string;
  busy: boolean;
  onCreateOrganization: (name: string) => void;
  onSelectOrganization: (organizationId: string, slug: string) => void;
}) {
  const [creating, setCreating] = useState(false);
  const requestCreate = useCallback((event: Event) => {
    event.preventDefault();
    setCreating(true);
  }, []);
  const create = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      onCreateOrganization(formValue(new FormData(event.currentTarget), "name"));
      setCreating(false);
    },
    [onCreateOrganization],
  );

  return (
    <>
      <SidebarSwitcher
        label="Organization"
        media={ORGANIZATION_MARK}
        primary={organization.name}
        secondary={ROLE_LABELS[role] ?? role}
      >
        <DropdownMenuLabel>Organizations</DropdownMenuLabel>
        {account.memberships.map((membership) => (
          <OrganizationItem
            key={membership.id}
            id={membership.id}
            name={membership.name}
            slug={membership.slug}
            selected={membership.id === organization.id}
            busy={busy}
            onSelect={onSelectOrganization}
          />
        ))}
        {account.canCreateOrganization ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={busy} onSelect={requestCreate}>
              <Plus aria-hidden="true" />
              New organization
            </DropdownMenuItem>
          </>
        ) : null}
      </SidebarSwitcher>
      <FormDialog
        open={creating}
        onOpenChange={setCreating}
        title="New organization"
        label="Create organization"
        submitLabel="Create organization"
        busy={busy}
        onSubmit={create}
      >
        <FormField
          id="new-organization-name"
          label="Organization name"
          kind="text"
          name="name"
          required
        />
      </FormDialog>
    </>
  );
}

function OrganizationItem({
  id,
  name,
  slug,
  selected,
  busy,
  onSelect,
}: {
  id: string;
  name: string;
  slug: string;
  selected: boolean;
  busy: boolean;
  onSelect: (organizationId: string, slug: string) => void;
}) {
  const handleSelect = useCallback(() => {
    onSelect(id, slug);
  }, [id, onSelect, slug]);

  return (
    <DropdownMenuItem
      disabled={busy}
      aria-current={selected ? "true" : undefined}
      data-organization-id={id}
      onSelect={handleSelect}
    >
      <span className="truncate">{name}</span>
      {selected ? <Check aria-hidden="true" className="ml-auto" /> : null}
    </DropdownMenuItem>
  );
}

/** One line, and no organization on it: the switcher above already says which one. */
export function ProjectSwitcher({ tenant }: { tenant: RouteTenant }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const route = routeSection(pathname);
  const section =
    route !== undefined && "projectSection" in route ? route.projectSection : "overview";
  const activeProjects = tenant.projects.filter((project) => project.status === "active");
  return (
    <SidebarSwitcher
      label="Project"
      size="default"
      media={PROJECT_MARK}
      primary={tenant.project?.name ?? "Project"}
    >
      <DropdownMenuLabel>Projects</DropdownMenuLabel>
      {activeProjects.map((project) => (
        <DropdownMenuItem key={project.id} asChild>
          <Link
            to={`/o/${tenant.organization.slug}/projects/${project.slug}/${section}` as never}
            aria-current={project.id === tenant.project?.id ? "true" : undefined}
          >
            <span className="truncate">{project.name}</span>
            {project.id === tenant.project?.id ? (
              <Check aria-hidden="true" className="ml-auto" />
            ) : null}
          </Link>
        </DropdownMenuItem>
      ))}
      <DropdownMenuSeparator />
      <DropdownMenuItem asChild>
        <Link to={`/o/${tenant.organization.slug}/projects` as never}>All projects</Link>
      </DropdownMenuItem>
    </SidebarSwitcher>
  );
}

/**
 * The account menu carries what belongs to the person rather than to a tenant. Instance
 * administration is one of those: `is_instance_operator` is a property of the user, so no
 * position inside the organization → project sidebar would be true.
 */
export function AccountMenu({
  email,
  name,
  operator,
  busy,
  onSignOut,
}: {
  email: string;
  name: string;
  operator: boolean;
  busy: boolean;
  onSignOut: () => void;
}) {
  const { isMobile, setOpenMobile } = useSidebar();
  // On compact the menu opens inside the drawer covering the destination, so leaving for the
  // instance has to dismiss it the way a sidebar destination does.
  const navigate = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);
  return (
    <SidebarSwitcher
      label={email}
      side="top"
      tone="accent"
      media={initials(name, email)}
      primary={name}
      secondary={email}
    >
      {operator ? (
        <>
          <DropdownMenuItem asChild>
            <Link to={INSTANCE_ENTRY} onClick={navigate}>
              <ShieldCheck aria-hidden="true" />
              Instance administration
            </Link>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
        </>
      ) : null}
      <DropdownMenuItem disabled={busy} onSelect={onSignOut}>
        <LogOut aria-hidden="true" />
        Sign out
      </DropdownMenuItem>
    </SidebarSwitcher>
  );
}

function initials(name: string, email: string): string {
  const source = name.trim().length > 0 ? name.trim() : email;
  const parts = source.split(/[\s@.]+/u).filter((part) => part.length > 0);
  return parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}
