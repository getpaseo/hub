const CONVERSATION_KEY_PROVIDERS = new Set(["github", "slack", "discord"]);

export function providerSupportsWorkspaceAffinityConversationKey(provider: string): boolean {
  return CONVERSATION_KEY_PROVIDERS.has(provider);
}

export function triggerSupportsWorkspaceAffinityConversationKey(eventName: string): boolean {
  const separator = eventName.indexOf(".");
  return (
    separator > 0 && providerSupportsWorkspaceAffinityConversationKey(eventName.slice(0, separator))
  );
}
