import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import {
  deliveryNamed,
  field,
  integer,
  list,
  readJson,
  record,
  text,
} from "./contract-test-read.js";

const fixturesRoot = join(dirname(fileURLToPath(import.meta.url)), "contract-fixtures");

describe("Forgejo 16.0.3 fixture manifest", () => {
  it("marks incomplete label and review deliveries as reconciliation signals", async () => {
    const manifest = record(await readJson(join(fixturesRoot, "manifest.json")), "manifest");
    const label = deliveryNamed(field(manifest, "deliveries"), "issue-label-updated");
    const prLabel = deliveryNamed(field(manifest, "deliveries"), "pull-request-label-updated");
    const review = deliveryNamed(field(manifest, "deliveries"), "pull-request-review-submitted");
    assert.equal(field(label, "incompleteLabelSignal"), true);
    assert.equal(field(prLabel, "incompleteLabelSignal"), true);
    assert.equal(field(review, "incompleteReviewSignal"), true);
    assert.equal(field(label, "semantic"), "forgejo.issue_label_added");
    assert.equal(field(prLabel, "semantic"), "forgejo.pull_request_label_added");

    const labelBody = record(
      field(
        record(
          await readJson(join(fixturesRoot, text(field(label, "file"), "file"))),
          "label fixture",
        ),
        "body",
      ),
      "label body",
    );
    assert.equal(field(labelBody, "action"), "label_updated");
    assert.equal(Object.hasOwn(labelBody, "label"), false);

    const submitted = record(
      field(
        record(
          field(
            record(
              await readJson(join(fixturesRoot, text(field(review, "file"), "file"))),
              "review fixture",
            ),
            "body",
          ),
          "review body",
        ),
        "review",
      ),
      "review",
    );
    assert.equal(field(submitted, "id"), undefined);
    assert.deepEqual(Object.keys(submitted).sort(), ["content", "type"]);
  });

  it("includes hydration records with stable source-record identities", async () => {
    const hydration = record(
      field(record(await readJson(join(fixturesRoot, "manifest.json")), "manifest"), "hydration"),
      "hydration",
    );
    const timelineIssue = list(
      await readJson(join(fixturesRoot, text(field(hydration, "timelineIssue"), "timelineIssue"))),
      "timelineIssue",
    );
    const labelRecord = record(
      timelineIssue.find((entry) => field(record(entry, "timeline"), "type") === "label"),
      "label record",
    );
    assert.equal(field(labelRecord, "body"), "1");
    integer(field(labelRecord, "id"), "label id");

    const timelinePr = list(
      await readJson(join(fixturesRoot, text(field(hydration, "timelinePr"), "timelinePr"))),
      "timelinePr",
    );
    const reviewRecord = record(
      timelinePr.find((entry) => field(record(entry, "timeline"), "type") === "review"),
      "review record",
    );
    integer(field(reviewRecord, "id"), "review timeline id");
    const reviewId = integer(field(reviewRecord, "review_id"), "review_id");
    assert.notEqual(reviewId, 0);

    const reviews = list(
      await readJson(join(fixturesRoot, text(field(hydration, "reviews"), "reviews"))),
      "reviews",
    );
    assert.equal(
      reviews.some((entry) => field(record(entry, "review"), "id") === reviewId),
      true,
    );

    const comments = list(
      await readJson(
        join(fixturesRoot, text(field(hydration, "reviewComments"), "reviewComments")),
      ),
      "reviewComments",
    );
    assert.equal(comments.length > 0, true);
    const firstComment = record(comments[0], "first comment");
    assert.equal(field(firstComment, "path"), "review-target.txt");
    integer(field(firstComment, "id"), "comment id");

    const reactions = record(
      await readJson(join(fixturesRoot, text(field(hydration, "reactions"), "reactions"))),
      "reactions",
    );
    assert.equal(field(record(field(reactions, "issueGet"), "issueGet"), "status"), 200);
    assert.equal(field(record(field(reactions, "commentGet"), "commentGet"), "status"), 200);
    const inlinePost = record(field(reactions, "inlinePost"), "inlinePost");
    assert.equal(field(inlinePost, "status"), 200);
    assert.equal(field(inlinePost, "content"), "-1");
    assert.equal(
      field(record(field(reactions, "submittedReviewPost"), "submittedReviewPost"), "status"),
      405,
    );

    const repository = record(
      await readJson(join(fixturesRoot, text(field(hydration, "repository"), "repository"))),
      "repository",
    );
    assert.equal(field(repository, "status"), 200);
    const repoBody = record(field(repository, "body"), "repository body");
    assert.equal(field(repoBody, "id"), 1);
    assert.equal(field(repoBody, "full_name"), "t00org/t00repo");

    const hubYaml = record(
      await readJson(
        join(fixturesRoot, text(field(hydration, "contentsHubYaml"), "contentsHubYaml")),
      ),
      "hub yaml",
    );
    assert.equal(field(hubYaml, "status"), 200);
    const yamlBody = record(field(hubYaml, "body"), "yaml body");
    assert.equal(field(yamlBody, "path"), ".paseo/hub.yaml");
    assert.equal(field(yamlBody, "encoding"), "base64");
    assert.equal(
      Buffer.from(text(field(yamlBody, "content"), "content"), "base64")
        .toString("utf8")
        .includes("environments:"),
      true,
    );

    const capability = record(
      await readJson(join(fixturesRoot, text(field(hydration, "apiCapability"), "apiCapability"))),
      "capability",
    );
    assert.equal(
      field(record(field(capability, "version"), "version"), "version"),
      "16.0.3+gitea-1.22.0",
    );
    assert.equal(
      field(record(field(capability, "settings"), "settings"), "max_response_items"),
      50,
    );
    const missing = record(field(capability, "reviewCommentList404"), "reviewCommentList404");
    assert.equal(field(missing, "pullsIndexComments"), 404);
    assert.equal(field(missing, "repoPullComments"), 404);
  });

  it("distinguishes issue comments from pull-request comments via X-Forgejo-Event-Type", async () => {
    const manifest = record(await readJson(join(fixturesRoot, "manifest.json")), "manifest");
    const issueComment = deliveryNamed(field(manifest, "deliveries"), "issue-comment-created");
    const prComment = deliveryNamed(field(manifest, "deliveries"), "pull-request-comment-created");
    assert.equal(field(issueComment, "event"), "issue_comment");
    assert.equal(field(issueComment, "eventType"), "issue_comment");
    assert.equal(field(prComment, "event"), "issue_comment");
    assert.equal(field(prComment, "eventType"), "pull_request_comment");
  });
});
