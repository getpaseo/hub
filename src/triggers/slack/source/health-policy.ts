export type SlackActionReason =
  | "appTokenRejected"
  | "workspaceAccessDenied"
  | "networkRestricted"
  | "hubConfigurationInvalid"
  | "appIdentityMismatch"
  | "socketModeOff"
  | "connectionLimit";

export type SlackActionPersistenceReason =
  | "app_token_rejected"
  | "workspace_access_denied"
  | "network_restricted"
  | "hub_configuration_invalid"
  | "app_identity_mismatch"
  | "socket_mode_off"
  | "connection_limit";

interface SlackActionPolicy {
  persistenceReason: SlackActionPersistenceReason;
  operation: "slack.socket.authenticate" | "slack.socket.configure" | "slack.socket.connect";
  failureKind: "authentication" | "validation" | "network";
  operatorAction: string;
  canRetry: boolean;
}

const ACTION_POLICIES: Readonly<Record<SlackActionReason, SlackActionPolicy>> = {
  appTokenRejected: {
    persistenceReason: "app_token_rejected",
    operation: "slack.socket.authenticate",
    failureKind: "authentication",
    operatorAction:
      "Allow this Hub server's IP for the app-level token, then replace the token if Slack still rejects it",
    canRetry: false,
  },
  workspaceAccessDenied: {
    persistenceReason: "workspace_access_denied",
    operation: "slack.socket.configure",
    failureKind: "validation",
    operatorAction: "Allow this Slack app in the workspace or organization, then retry",
    canRetry: true,
  },
  networkRestricted: {
    persistenceReason: "network_restricted",
    operation: "slack.socket.connect",
    failureKind: "network",
    operatorAction: "Allow this Hub server's network to reach Slack, then retry",
    canRetry: true,
  },
  hubConfigurationInvalid: {
    persistenceReason: "hub_configuration_invalid",
    operation: "slack.socket.configure",
    failureKind: "validation",
    operatorAction: "Update Hub, then reconnect this Slack app",
    canRetry: false,
  },
  appIdentityMismatch: {
    persistenceReason: "app_identity_mismatch",
    operation: "slack.socket.configure",
    failureKind: "validation",
    operatorAction: "Use the App ID and app-level token from the same Slack app",
    canRetry: false,
  },
  socketModeOff: {
    persistenceReason: "socket_mode_off",
    operation: "slack.socket.configure",
    failureKind: "validation",
    operatorAction: "Turn on Socket Mode in Slack, then retry",
    canRetry: true,
  },
  connectionLimit: {
    persistenceReason: "connection_limit",
    operation: "slack.socket.connect",
    failureKind: "validation",
    operatorAction: "Stop extra Hub servers or use Webhooks",
    canRetry: true,
  },
};

const ACTION_REASONS: readonly SlackActionReason[] = [
  "appTokenRejected",
  "workspaceAccessDenied",
  "networkRestricted",
  "hubConfigurationInvalid",
  "appIdentityMismatch",
  "socketModeOff",
  "connectionLimit",
];

const OPEN_FAILURE_REASONS: Readonly<Record<string, SlackActionReason>> = Object.fromEntries([
  ...[
    "account_inactive",
    "invalid_auth",
    "missing_scope",
    "not_allowed_token_type",
    "token_expired",
    "token_revoked",
    "no_permission",
  ].map((code) => [code, "appTokenRejected"] as const),
  ["accesslimited", "networkRestricted"],
  ...[
    "access_denied",
    "ekm_access_denied",
    "enterprise_is_restricted",
    "forbidden_team",
    "team_access_not_granted",
    "two_factor_setup_required",
  ].map((code) => [code, "workspaceAccessDenied"] as const),
  ...[
    "deprecated_endpoint",
    "insecure_request",
    "invalid_arg_name",
    "invalid_arguments",
    "invalid_array_arg",
    "invalid_charset",
    "invalid_form_data",
    "invalid_post_type",
    "method_deprecated",
    "missing_args",
    "missing_post_type",
    "not_authed",
    "request_timeout",
  ].map((code) => [code, "hubConfigurationInvalid"] as const),
]);

export function classifySlackOpenFailure(code: string): SlackActionReason | undefined {
  return OPEN_FAILURE_REASONS[code];
}

export function slackActionPolicy(reason: SlackActionReason): SlackActionPolicy {
  return ACTION_POLICIES[reason];
}

export function slackActionReasonFromPersistence(
  reason: string | null,
): SlackActionReason | undefined {
  return ACTION_REASONS.find(
    (candidate) => ACTION_POLICIES[candidate].persistenceReason === reason,
  );
}
