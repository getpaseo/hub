# Linear

Hub starts agents from Linear issues, comments, and agent sessions, and reports back in Linear.
Delegate an issue to Paseo or mention it, and the run appears in the issue's agent session; issue
and comment triggers answer with an ordinary comment.

## Set up the Linear application

Linear sends webhooks only to HTTPS, so open Hub at its public HTTPS address first. Then, under
**Apps**, choose **Linear** and follow the steps there:

1. Open [Linear API applications](https://linear.app/settings/api/applications), create an
   application, and give it a name. That name is how Paseo appears in Linear.
2. Add the **Redirect URL** Hub shows (`https://<hub>/api/integrations/linear/callback`) to the
   application's OAuth settings.
3. Turn on the application's webhook with the **Webhook URL** Hub shows
   (`https://<hub>/api/integrations/linear/events`) and a signing secret, and subscribe it to
   **Issue**, **Comment**, and **Agent session events**.
4. Paste the application's **Client ID**, **Client Secret**, and the webhook signing secret into
   Hub and save.

Then connect a Linear workspace. A workspace administrator authorizes the application, and Hub
installs it as the application itself, so comments and session activity come from Paseo rather
than from the administrator. Choose how much Paseo may do:

| Connection                                | Scopes                                               | Allows                                                    |
| ----------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------- |
| **Connect Linear without Agent Sessions** | `read`, `comments:create`                            | Issue and comment triggers.                               |
| **Connect Linear for Agent Sessions**     | `read`, `write`, `app:assignable`, `app:mentionable` | Those, plus delegating issues to Paseo and mentioning it. |

To add agent sessions to an existing workspace, choose **Reauthorize Linear for Agent Sessions** on
its connection.

Deployments that manage secrets outside Hub can set `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`,
and `LINEAR_WEBHOOK_SECRET` instead.

## Events

| Event                        | Starts a run when                                                        |
| ---------------------------- | ------------------------------------------------------------------------ |
| `linear.agent_session`       | Someone delegates an issue to Paseo, mentions it, or follows up with it. |
| `linear.comment_created`     | Someone comments on an issue.                                            |
| `linear.issue_assigned`      | Someone assigns an issue to a person.                                    |
| `linear.issue_entered_scope` | An issue is created in, or changed to match, the trigger's filters.      |

`linear.issue_entered_scope` runs once as an issue enters scope, not again for each later edit. It
requires `filters.project` or `filters.team`. Every other event requires `filters.from_users`.

## Filters

Filters take Linear IDs, not names. Copy one from Linear's command menu with **Copy model UUID**.

| Filter            | Matches                                                                    |
| ----------------- | -------------------------------------------------------------------------- |
| `project`         | Issues in this project.                                                    |
| `team`            | Issues in this team. Use it for issues that have no project.               |
| `states`          | Issues in any of these workflow states.                                    |
| `assignees`       | Issues assigned to any of these people.                                    |
| `labels`          | Issues with all of these labels.                                           |
| `exclude_labels`  | Issues with none of these labels.                                          |
| `from_users`      | Events by any of these people. `"*"` accepts everyone.                     |
| `pattern`         | Comments or session messages that start with this text.                    |
| `contains`        | Comments or session messages that contain this text.                       |
| `replies_only`    | Replies to a comment, not new threads. `linear.comment_created` only.      |
| `thread_with_app` | Replies in a thread Paseo has commented in. `linear.comment_created` only. |

`project` or `team` also decides which Hub project receives the event. Without either, a trigger
receives every issue in the workspace.

Hub ignores everything Paseo itself writes in Linear, so `from_users: ["*"]` never lets a reply
start another run.

## Agent sessions

When someone delegates an issue to Paseo or mentions it, Linear opens an agent session on the
issue and Hub matches `linear.agent_session`. For a new session, `${{ paseo.prompt }}` is the prompt
Linear prepares: the issue, its discussion, and your workspace's agent guidance. For a follow-up, it
is what the person wrote.

Linear opens no new session when an issue is delegated to Paseo while Paseo already has one on it.
Hub then opens the session itself, a few seconds after the delegation, and starts the run for the
person who delegated. Its `${{ paseo.prompt }}` is the issue's title and description, and the
issue's comments arrive in `thread`. This needs the **Issue** webhook subscription.

Hub acknowledges the session as soon as it accepts the run. The agent answers with its `reply`
tool: a response closes the session, and a question leaves it waiting for an answer, optionally
with choices to pick from. The answer arrives as a follow-up and starts a new run that continues
the same agent. If the agent finishes without replying, Hub closes the session itself; if the run
fails or its reply cannot be delivered, the session shows the error.

**Stop** in Linear stops the session's running and queued work, and the session confirms it.

A mention that opens a session is also a comment. When a session trigger takes it, Hub does not
also answer the comment, so the person gets one reply.

Every run on the same issue, from a session or a comment, continues the agent already working on
that issue.

Linear's agent features are a Developer Preview and may change.

## Context

`${{ paseo.context }}` contains a `linear` object:

- `event_type`, `action`, and `occurred_at`: what happened and when.
- `actor`: who did it.
- `issue`: `id`, `identifier`, `title`, `description`, `url`, `project`, `team`, `state`,
  `assignee`, and `label_ids`.
- `comment`: the triggering comment and its `parent_id`, for comment events.
- `agent_session`, `agent_activity`, and `prompt_context`: the session, the follow-up that started
  this run, and the prompt Linear prepared, for session events.
- `thread`: the issue followed by the discussion before the event, up to 50 messages. `status` is
  `incomplete` when there was more, and `unavailable` when Hub could not read it.

## Replies

Every Linear run can reply. In an agent session the reply goes into the session; otherwise it is a
comment, threaded under the comment that started the run. A question with choices posted as a
comment lists the choices under it.

## Pull requests

Hub does not change an issue's status. With Linear's GitHub integration installed, Linear moves the
issue itself when a pull request names it, for example in a branch called `eng-42-fix-login` or a
title containing `ENG-42`. Ask the agent to do that in the trigger's prompt.

## Example

This trigger takes every delegation, mention, and follow-up for one Linear team:

```yaml
name: linear-agent
on:
  linear.agent_session:
    filters:
      team: 3f2b4c1e-8a7d-4e6f-9b0a-1c2d3e4f5a6b
      from_users: ["*"]
run:
  target:
    daemon: your-daemon
    cwd: /workspace/project
  agent:
    provider: claude
  prompt: |
    ${{ paseo.prompt }}

    Linear context: ${{ paseo.context }}

    Work on a branch whose name starts with the issue identifier, open a pull request with the
    identifier in its title, and reply with the pull request URL. Ask a question instead if the
    issue is unclear.
  max_runtime: 2h
  idle_timeout: 10m
```
