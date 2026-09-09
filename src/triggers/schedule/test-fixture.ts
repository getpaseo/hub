export const scheduleYaml = `# scheduled scan
name: scheduled-scan
on:
  schedule.tick:
    recurrence:
      frequency: daily
      times: ["09:00", "17:00"]
      timezone: Europe/Berlin
run:
  target: { daemon: devbox, cwd: /workspace }
  agent: { provider: test, mode: full-access, thinkingOptionId: low }
  prompt: 'Scan at \${{ paseo.context }}'
`;
