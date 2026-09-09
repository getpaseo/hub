export const scheduleYaml = `# scheduled scan
name: scheduled-scan
on:
  schedule.tick:
    recurrence:
      start: "2026-01-01T09:00:00"
      rule: "FREQ=DAILY;BYHOUR=9,17"
      timezone: Europe/Berlin
run:
  target: { daemon: devbox, cwd: /workspace }
  agent: { provider: test, mode: full-access, thinkingOptionId: low }
  prompt: 'Scan at \${{ paseo.context }}'
`;
