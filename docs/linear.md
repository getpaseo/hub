# Linear triggers

Hub can receive signed Linear Issue and Comment webhooks, route them to a project, and post a
workflow result back as a normal Linear comment. Linear is connected at the organization level;
each workflow still chooses its own Linear project and its own GitHub authority.

## Configure the Linear app

In Hub's **Apps** page, create a Linear application and paste its Client ID, Client Secret, and
webhook signing secret. Hub then sends an administrator through Linear OAuth; it does not save the
application or activate its webhook until that authorization succeeds.

For an environment-managed installation instead, set all three variables on Hub:

```text
LINEAR_CLIENT_ID=
LINEAR_CLIENT_SECRET=
LINEAR_WEBHOOK_SECRET=
```

In the Linear application's OAuth settings, register this redirect URL:

```text
https://YOUR-HUB/api/integrations/linear/callback
```

Configure an Issue and Comment webhook for this URL, using the same signing secret:

```text
https://YOUR-HUB/api/integrations/linear/events
```

Then connect Linear from the organization's **Connections** page. Hub installs as a Linear app,
so its result comments are visibly authored by Paseo rather than the administrator who connected
it. The connection therefore needs a workspace administrator and requests only `read` plus
`comments:create`. Hub verifies the HMAC signature against the raw request body and rejects
webhook timestamps more than one minute from its clock.

## Trigger types and filters

`linear.issue_entered_scope` is for intentionally autonomous workflows. It requires a
`filters.project` and fires once when an issue is created in, or transitions into, that matching
scope. A later title or description edit does not start another run.

`linear.issue_assigned` and `linear.comment_created` are reactive. They require a non-empty
`filters.from_users` allowlist; use stable Linear user IDs.

Use Linear IDs, not display names, for `project`, `states`, `labels`, `exclude_labels`, and
`assignees`. `from_users` is the actor who made the assignment or comment; `assignees` filters the
issue's resulting assignee.

## Project scout: first-draft PRs

The pattern below lets Paseo assess every issue that enters a chosen project scope. The first step
has no Hub-issued GitHub write authority and returns structured eligibility. Only an eligible issue
reaches the second step, which has explicit GitHub write authority and can emit one Linear comment
containing the draft PR URL.

```yaml
environments:
  - name: local
    kind: daemon
    daemon: workstation
    cwd: /work/acme/repo
    worktree:
      mode: branch-off
      newBranch: "paseo/linear-${{ paseo.execution.id }}"

triggers:
  - name: linear-project-scout
    on: linear.issue_entered_scope
    max_runtime: 2h
    filters:
      connection: acme-linear
      project: 00000000-0000-0000-0000-000000000000
      states:
        - 11111111-1111-1111-1111-111111111111 # Ready
      exclude_labels:
        - 22222222-2222-2222-2222-222222222222 # no-paseo
    steps:
      - id: assess
        environment: local
        max_runtime: 20m
        idle_timeout: 5m
        agent: { provider: codex }
        prompt:
          - text: |
              Assess the Linear issue in the following trigger context for a safe,
              self-contained first-draft PR. Set eligible to true only when the requested change
              is clear, bounded, testable, and does not require product/security decisions.

              ${{ paseo.context }}
        output:
          schema:
            type: object
            required: [eligible]
            properties:
              eligible: { type: boolean }

      - id: implement
        if: "${{ steps.assess.outputs.eligible == true }}"
        environment: local
        max_runtime: 90m
        idle_timeout: 10m
        agent: { provider: codex }
        github:
          connection: acme-github
          repositories: [acme/repo]
          permissions:
            contents: write
            pull_requests: write
        allow_outputs:
          - type: linear.reply
            max: 1
            required: true
        prompt:
          - text: |
              Implement the issue, run focused checks, open a draft PR, then emit linear.reply
              with the PR URL and a short summary. Do not open a PR if the issue proves ambiguous.
```

The agent receives the normalized issue and, for comments, the comment body through
`${{ paseo.context }}`. Hub does not silently grant repository access: the `github` block on the
implementation step is the only source of GitHub write authority. See
[workflow authority](./workflow-authority.md) for the repository and permission contract.
