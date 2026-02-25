export interface ChannelConfig {
  name: string;
  /** Discussion group chat ID (the linked supergroup, not the channel itself). */
  chatId: number;
  /** Extra system prompt prepended to the main agent's prompt. */
  systemPrompt?: string;
  /** Whether to run retrieval (default: true). */
  enableRetrieval?: boolean;
  /** Whether to run KB updater (default: true). */
  enableKBUpdate?: boolean;
}

// Each entry maps a Telegram discussion group to a channel config.
// chatId = the linked supergroup ID (negative number), visible in bot logs or via getUpdates.
const channels: ChannelConfig[] = [
  {
    name: "Reflection",
    chatId: -1003801218623,
    systemPrompt: "[Placeholder] This is a journaling and reflection channel. Help David reflect on his thoughts, emotions, and experiences. Ask follow-up questions that encourage deeper introspection. The tone should be warm, curious, and non-judgmental.",
    enableRetrieval: true,
    enableKBUpdate: true,
  },
  {
    name: "Direct",
    chatId: -1003881403661,
    enableRetrieval: false,
    enableKBUpdate: false,
  },
];

const channelByChatId = new Map(channels.map(c => [c.chatId, c]));

export function getChannelConfig(chatId: number): ChannelConfig | undefined {
  return channelByChatId.get(chatId);
}

export function getAllowedChatIds(): Set<number> {
  return new Set(channels.map(c => c.chatId));
}
