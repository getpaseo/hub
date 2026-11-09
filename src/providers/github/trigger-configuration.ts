import type { ProviderConfigurationDefinition } from "../configuration.js";
import { filterFields, projectLegacyFilters } from "./filter-configuration.js";

const ADDED_LABEL = {
  key: "label",
  kind: "string",
  label: "Added label",
  description:
    "Match the label added by this event, not labels already on the issue or pull request.",
  required: true,
} as const;
export const triggerConfiguration: ProviderConfigurationDefinition = {
  filterFields,
  projectLegacyFilters,
  provider: "github",
  order: 2,
  replyType: "github.reply",
  events: {
    "github.issue_created": { label: "GitHub issue created" },
    "github.pull_request_created": { label: "GitHub pull request created" },
    "github.pull_request_ready_for_review": { label: "GitHub pull request ready for review" },
    "github.pull_request_synchronized": { label: "GitHub pull request updated with new commits" },
    "github.issue_comment_created": { label: "GitHub issue comment created" },
    "github.pull_request_comment_created": { label: "GitHub pull request comment created" },
    "github.issue_label_added": { label: "GitHub issue label added", qualifiers: [ADDED_LABEL] },
    "github.pull_request_label_added": {
      label: "GitHub pull request label added",
      qualifiers: [ADDED_LABEL],
    },
    "github.issue_comment": { label: "GitHub issue or PR comment webhook" },
    "github.issues": { label: "GitHub issue webhook" },
    "github.pull_request": { label: "GitHub pull request webhook" },
    "github.pull_request_review": { label: "GitHub pull request review webhook" },
    "github.pull_request_review_comment": { label: "GitHub review comment webhook" },
    "github.push": { label: "GitHub push" },
  },
};
