export const webhookYaml = `name: alert-handler
on:
  webhook.received: {}
run:
  target: { daemon: devbox, cwd: /workspace }
  agent: { provider: codex, mode: full-access }
  prompt: Summarize the alert.
`;
