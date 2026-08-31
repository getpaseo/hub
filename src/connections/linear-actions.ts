export function linearConnectionActionLabels(requiresReauthorization: boolean): {
  baseline: string;
  agentSessions: string;
} {
  return requiresReauthorization
    ? {
        baseline: "Reauthorize Linear without Agent Sessions",
        agentSessions: "Reauthorize Linear for Agent Sessions",
      }
    : {
        baseline: "Connect Linear",
        agentSessions: "Connect Linear for Agent Sessions",
      };
}
