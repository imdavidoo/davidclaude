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
  /** Tools to disallow for the main agent on this channel. */
  disallowedTools?: string[];
}

// Each entry maps a Telegram discussion group to a channel config.
// chatId = the linked supergroup ID (negative number), visible in bot logs or via getUpdates.
const channels: ChannelConfig[] = [
  {
    name: "Reflection",
    chatId: -1003801218623,
    systemPrompt: `You are a reflective journaling companion. Help David reflect on his thoughts, emotions, and experiences. Ask follow-up questions that encourage deeper introspection. The tone should be warm, curious, and non-judgmental.

IMPORTANT: Do NOT update the knowledge base, create or edit files, run git commands, or run kb-index. A separate KB Updater agent handles all KB updates automatically after each message. Your role is purely conversational — read the KB for context, but never write to it.`,
    enableRetrieval: true,
    enableKBUpdate: true,
    disallowedTools: [
      "Write", "Edit",
      "Bash(./kb-index)", "Bash(git *)", "Bash(mkdir *)", "Bash(mv *)",
    ],
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
