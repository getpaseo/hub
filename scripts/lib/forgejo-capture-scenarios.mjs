import { hasLabel, isEvent, waitMatching } from "./forgejo-capture-matchers.mjs";
import { sleep } from "./forgejo-capture-instance.mjs";

// "issues" and "pull_request" are blanket keys that also cover labels, comments and
// (for pull_request) reviews; listed explicitly anyway so intent survives a refactor.
export const HOOK_EVENTS = [
  "create",
  "delete",
  "fork",
  "push",
  "issues",
  "issue_assign",
  "issue_label",
  "issue_comment",
  "pull_request",
  "pull_request_assign",
  "pull_request_label",
  "pull_request_comment",
  "pull_request_review",
  "wiki",
  "repository",
  "release",
];

/** Drive every scenario the fixtures need, capturing (and writing) each delivery. */
export async function drive({ trillian, zaphod, listener, fixtures }) {
  let seen = 0;
  const next = async (label, predicate) => {
    const found = await waitMatching(listener, seen, predicate);
    seen = found.index + 1;
    await fixtures.saveDelivery(label, found.delivery);
    return found.delivery;
  };

  const issue = await trillian("POST", "/api/v1/repos/acme/widgets/issues", {
    title: "Improbability drive stalls",
    body: "on cold mornings",
  });
  await next(
    "issue-opened",
    isEvent("issues", (b) => b.action === "opened"),
  );

  await zaphod("POST", `/api/v1/repos/acme/widgets/issues/${issue.body.number}/comments`, {
    body: "@paseo have a look",
  });
  await next(
    "issue-comment-created",
    isEvent(
      "issue_comment",
      (b) => b.action === "created" && b.comment?.body?.includes("have a look"),
    ),
  );

  await zaphod("POST", `/api/v1/repos/acme/widgets/issues/${issue.body.number}/labels`, {
    labels: ["bug"],
  });
  await next(
    "issue-label-added",
    isEvent("issues", (b) => b.action === "label_updated" && hasLabel(b, "bug")),
  );

  // add "triage" then remove "bug": two separate deliveries
  await zaphod("POST", `/api/v1/repos/acme/widgets/issues/${issue.body.number}/labels`, {
    labels: ["triage"],
  });
  await next(
    "issue-label-triage-added",
    isEvent(
      "issues",
      (b) => b.action === "label_updated" && hasLabel(b, "triage") && hasLabel(b, "bug"),
    ),
  );
  await zaphod("DELETE", `/api/v1/repos/acme/widgets/issues/${issue.body.number}/labels/bug`);
  await next(
    "issue-label-bug-removed",
    isEvent("issues", (b) => b.action === "label_updated" && !hasLabel(b, "bug")),
  );

  await zaphod("DELETE", `/api/v1/repos/acme/widgets/issues/${issue.body.number}/labels`);
  await next(
    "issue-labels-cleared",
    isEvent("issues", (b) => b.action === "label_cleared"),
  );

  const timelineAfterLabel = await trillian(
    "GET",
    `/api/v1/repos/acme/widgets/issues/${issue.body.number}/timeline`,
  );
  await fixtures.saveApiFixture("issue-timeline-after-label", timelineAfterLabel.body);

  await trillian("PATCH", `/api/v1/repos/acme/widgets/issues/${issue.body.number}`, {
    assignees: ["zaphod"],
  });
  await next(
    "issue-assigned",
    isEvent("issues", (b) => b.action === "assigned"),
  );

  const timelineAfterAssign = await trillian(
    "GET",
    `/api/v1/repos/acme/widgets/issues/${issue.body.number}/timeline`,
  );
  await fixtures.saveApiFixture("issue-timeline-after-assign", timelineAfterAssign.body);

  // pull request opened: branch + file commit, then open the PR
  await zaphod("POST", "/api/v1/repos/acme/widgets/contents/widget.txt", {
    message: "add widget",
    branch: "main",
    new_branch: "feature/improbability",
    content: Buffer.from("42\n").toString("base64"),
  });
  const pr = await zaphod("POST", "/api/v1/repos/acme/widgets/pulls", {
    head: "feature/improbability",
    base: "main",
    title: "Add the widget",
    body: "Needed for the improbability drive",
  });
  await next(
    "pull-request-opened",
    isEvent("pull_request", (b) => b.action === "opened"),
  );

  await trillian("POST", `/api/v1/repos/acme/widgets/issues/${pr.body.number}/comments`, {
    body: "looks reasonable",
  });
  await next(
    "pull-request-comment-created",
    isEvent(
      "issue_comment",
      (b) => b.action === "created" && b.comment?.body === "looks reasonable",
    ),
  );

  await trillian("POST", `/api/v1/repos/acme/widgets/issues/${pr.body.number}/labels`, {
    labels: ["bug"],
  });
  await next(
    "pull-request-label-added",
    isEvent("pull_request", (b) => b.action === "label_updated" && hasLabel(b, "bug")),
  );

  await trillian("PATCH", `/api/v1/repos/acme/widgets/issues/${pr.body.number}`, {
    assignees: ["zaphod"],
  });
  await next(
    "pull-request-assigned",
    isEvent("pull_request", (b) => b.action === "assigned"),
  );

  await trillian("POST", `/api/v1/repos/acme/widgets/pulls/${pr.body.number}/reviews`, {
    event: "APPROVED",
    body: "ship it",
  });
  await next(
    "pull-request-review-approved",
    isEvent("pull_request_approved", (b) => b.review?.type === "pull_request_review_approved"),
  );

  await trillian("POST", `/api/v1/repos/acme/widgets/pulls/${pr.body.number}/reviews`, {
    event: "REQUEST_CHANGES",
    body: "needs work",
  });
  await next(
    "pull-request-review-rejected",
    isEvent("pull_request_rejected", (b) => b.review?.type === "pull_request_review_rejected"),
  );

  // a review submitted as a plain comment, not approve/reject
  await trillian("POST", `/api/v1/repos/acme/widgets/pulls/${pr.body.number}/reviews`, {
    event: "COMMENT",
    body: "one more thought",
  });
  await next(
    "pull-request-review-comment",
    isEvent("pull_request_comment", (b) => b.review?.type === "pull_request_review_comment"),
  );

  await trillian("POST", "/api/v1/repos/acme/widgets/contents/pushed.txt", {
    message: "direct push to main",
    branch: "main",
    content: Buffer.from("mostly harmless\n").toString("base64"),
  });
  await next(
    "push",
    isEvent("push", (b) => b.ref === "refs/heads/main"),
  );

  // a second commit to the still-open PR's own branch: Forgejo raises this as a
  // `pull_request` delivery with action "synchronized", not a second `push`.
  await zaphod("POST", "/api/v1/repos/acme/widgets/contents/widget-2.txt", {
    message: "widget follow-up",
    branch: "feature/improbability",
    content: Buffer.from("54\n").toString("base64"),
  });
  await next(
    "pull-request-synchronized",
    isEvent("pull_request", (b) => b.action === "synchronized"),
  );

  // the PR's own poster re-requests review from trillian, who already left a review
  // above: a poster can only pick a reviewer who has already reviewed.
  await zaphod("POST", `/api/v1/repos/acme/widgets/pulls/${pr.body.number}/requested_reviewers`, {
    reviewers: ["trillian"],
  });
  await next(
    "pull-request-review-requested",
    isEvent("pull_request", (b) => b.action === "review_requested"),
  );

  await trillian("PATCH", `/api/v1/repos/acme/widgets/issues/${pr.body.number}`, {
    state: "closed",
  });
  await next(
    "pull-request-closed",
    isEvent("pull_request", (b) => b.action === "closed" && b.pull_request?.merged !== true),
  );

  await trillian("PATCH", `/api/v1/repos/acme/widgets/issues/${pr.body.number}`, {
    state: "open",
  });
  await next(
    "pull-request-reopened",
    isEvent("pull_request", (b) => b.action === "reopened"),
  );

  // mergeability is checked in the background after the branch settles, so a merge
  // attempted right away can still 405 "not ready to be merged" for a moment
  for (let attempt = 1; ; attempt += 1) {
    try {
      await trillian("POST", `/api/v1/repos/acme/widgets/pulls/${pr.body.number}/merge`, {
        Do: "merge",
      });
      break;
    } catch (error) {
      if (attempt >= 20 || !String(error).includes("405")) throw error;
      await sleep(500);
    }
  }
  const mergedDelivery = await next(
    "pull-request-merged",
    isEvent("pull_request", (b) => b.action === "closed" && b.pull_request?.merged === true),
  );
  // events.ts assumes merging sends exactly one `closed` delivery; catch a stray
  // second one here instead of silently trusting that.
  await sleep(3_000);
  const strayClosed = listener.deliveries
    .slice(seen)
    .filter(
      (delivery) =>
        delivery.headers["x-forgejo-event"] === "pull_request" &&
        JSON.parse(delivery.body || "{}").action === "closed",
    );
  if (strayClosed.length > 0) {
    throw new Error(
      `expected exactly one 'closed' delivery for the merge of PR ${pr.body.number}, saw a second one too: ${JSON.stringify(strayClosed)}`,
    );
  }
  void mergedDelivery;

  await trillian("PATCH", `/api/v1/repos/acme/widgets/issues/${issue.body.number}`, {
    state: "closed",
  });
  await next(
    "issue-closed",
    isEvent("issues", (b) => b.action === "closed"),
  );

  await trillian("PATCH", `/api/v1/repos/acme/widgets/issues/${issue.body.number}`, {
    state: "open",
  });
  await next(
    "issue-reopened",
    isEvent("issues", (b) => b.action === "reopened"),
  );

  const userResponse = await trillian("GET", "/api/v1/user");
  await fixtures.saveApiFixture("user", userResponse.body);
  const orgsResponse = await trillian("GET", "/api/v1/user/orgs");
  await fixtures.saveApiFixture("user-orgs", orgsResponse.body);
}
