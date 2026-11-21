import { z } from "zod";

/**
 * How GitHub relates the author of an issue, pull request, comment, or review to the repository.
 * The values are GitHub's own; a trigger's `filters.author_associations` lists the ones it admits.
 */
export const GITHUB_AUTHOR_ASSOCIATIONS = [
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
  "CONTRIBUTOR",
  "FIRST_TIME_CONTRIBUTOR",
  "FIRST_TIMER",
  "MANNEQUIN",
  "NONE",
] as const;

export const GitHubAuthorAssociationSchema = z.enum(GITHUB_AUTHOR_ASSOCIATIONS);
export type GitHubAuthorAssociation = z.infer<typeof GitHubAuthorAssociationSchema>;

/** People GitHub lets write to the repository. */
export const MEMBER_ASSOCIATIONS: readonly GitHubAuthorAssociation[] = [
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
];

/** Members, and anyone with a commit already merged into the repository. */
export const CONTRIBUTOR_ASSOCIATIONS: readonly GitHubAuthorAssociation[] = [
  ...MEMBER_ASSOCIATIONS,
  "CONTRIBUTOR",
];

/**
 * GitHub restricts pushing to people with write access and reports no association on a push, so
 * an association filter there could never admit anyone.
 */
export function reportsAuthorAssociation(event: string): boolean {
  return event.startsWith("github.") && event !== "github.push";
}

/**
 * The actor's association, which GitHub reports only for the author of the object an event
 * carries. When someone else acts on that object, closing another person's issue or pushing to
 * their pull request, the payload describes the author and says nothing about the actor.
 */
export function actorAssociation(
  actor: string,
  authored:
    | { user?: { login?: string | undefined } | undefined; author_association?: string | undefined }
    | undefined,
): GitHubAuthorAssociation | undefined {
  if (actor === "" || authored?.user?.login !== actor) return undefined;
  const association = GitHubAuthorAssociationSchema.safeParse(authored.author_association);
  return association.success ? association.data : undefined;
}
