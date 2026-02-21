import { query } from "@anthropic-ai/claude-agent-sdk";

const CWD = "/home/imdavid/davidclaude";

// Strip CLAUDECODE env var so the child process doesn't think it's nested
const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => k !== "CLAUDECODE")
);

const ALLOWED_TOOLS = [
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "Task",
  "WebSearch",
  "WebFetch",
  "Bash(./kb-search *)",
  "Bash(./kb-index)",
  "Bash(git *)",
];

export interface PermissionDenial {
  toolName: string;
  input: unknown;
}

export interface ClaudeResult {
  response: string;
  sessionId: string;
  cost: number;
  permissionDenials: PermissionDenial[];
}

function formatToolUse(block: { name: string; input: Record<string, unknown> }): string {
  const { name, input } = block;
  switch (name) {
    case "Bash": {
      const cmd = String(input.command ?? "");
      const kbMatch = cmd.match(/\.\/kb-search\s+"([^"]*)"(?:\s+"([^"]*)")?/);
      if (kbMatch) return `🔍 KB search: "${kbMatch[2] ?? kbMatch[1]}"`;
      if (cmd.includes("./kb-index")) return "📇 Re-indexing KB";
      return `⚙️ Running: ${cmd.slice(0, 120)}`;
    }
    case "Read":
      return `📄 Reading ${String(input.file_path ?? "")}`;
    case "Task": {
      const desc = String(input.description ?? "");
      const prompt = String(input.prompt ?? "");
      return `🤖 Agent: ${desc}\n   Task: ${prompt}`;
    }
    case "Grep":
      return `🔎 Grep: "${String(input.pattern ?? "")}" in ${String(input.path ?? ".")}`;
    case "Glob":
      return `🔎 Glob: "${String(input.pattern ?? "")}" in ${String(input.path ?? ".")}`;
    case "WebSearch":
      return `🌐 Web search: "${String(input.query ?? "")}"`;
    case "WebFetch":
      return `🌐 Fetching: ${String(input.url ?? "")}`;
    case "Write":
      return `✏️ Writing ${String(input.file_path ?? "")}`;
    case "Edit":
      return `✏️ Editing ${String(input.file_path ?? "")}`;
    default: {
      const firstVal = Object.values(input)[0];
      return `🔧 ${name}: ${String(firstVal ?? "").slice(0, 100)}`;
    }
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

export async function sendMessage(
  text: string,
  sessionId?: string | null,
  onProgress?: (line: string) => void
): Promise<ClaudeResult> {
  const response = query({
    prompt: text,
    options: {
      cwd: CWD,
      pathToClaudeCodeExecutable: "/home/imdavid/.local/bin/claude",
      env: cleanEnv,
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        addendum: `You are running inside a Telegram bot. Do NOT use AskUserQuestion — it is unavailable. If you need clarification, make your best judgment and proceed.

Formatting rules (Telegram has limited formatting support):
- Bold (**text**), italic (*text*), strikethrough (~~text~~), inline code (\`code\`), code blocks (\`\`\`), blockquotes (>), and [links](url) all work.
- Do NOT use markdown headers (#, ##, etc.) — they have no Telegram equivalent. Instead just use **bold text** on its own line as a section label.
- Do NOT use markdown tables — they render as broken text. Use lists instead.
- Numbered lists (1. 2. 3.) work as plain text. Bullet markers (- or *) are converted to • characters.
- Keep formatting minimal and clean. Prefer plain text with selective bold for emphasis over heavily formatted responses.`,
      },
      settingSources: ["project", "local"],
      allowedTools: ALLOWED_TOOLS,
      maxTurns: 50,
      ...(sessionId ? { resume: sessionId } : {}),
    },
  });

  let finalSessionId = "";
  let result = "";
  let cost = 0;
  let permissionDenials: PermissionDenial[] = [];

  for await (const message of response) {
    // Capture session ID from init message
    if (message.type === "system" && message.subtype === "init") {
      finalSessionId = message.session_id;
    }

    // Capture result
    if (message.type === "result") {
      cost = message.total_cost_usd;
      permissionDenials = (message.permission_denials ?? []).map(
        (d: { tool_name: string; tool_use_id: string; tool_input: unknown }) => ({
          toolName: d.tool_name,
          input: d.tool_input,
        })
      );

      if (message.subtype === "success") {
        result = message.result;
      } else {
        const errors = "errors" in message ? message.errors : [];
        result = `Error (${message.subtype}): ${(errors as string[]).join("\n") || "Unknown error"}`;
      }
    }

    // Surface thinking + tool calls from assistant messages
    if (onProgress && message.type === "assistant") {
      const isTopLevel = message.parent_tool_use_id === null;
      const msg = message.message as {
        content?: Array<{
          type: string;
          text?: string;
          name?: string;
          input?: Record<string, unknown>;
        }>;
      };
      for (const block of msg.content ?? []) {
        // Show thinking/reasoning text (top-level only to avoid sub-agent noise)
        if (block.type === "text" && block.text && isTopLevel) {
          const text = block.text.trim();
          if (text) onProgress(`💭 ${truncate(text, 300)}`);
        }
        // Show tool calls (top-level only)
        if (block.type === "tool_use" && block.name && block.input && isTopLevel) {
          onProgress(formatToolUse(block as { name: string; input: Record<string, unknown> }));
        }
      }
    }

    // Surface task lifecycle
    if (onProgress && message.type === "system") {
      if (message.subtype === "task_started") {
        const m = message as { description?: string; task_id?: string };
        onProgress(`🚀 Agent started: ${m.description ?? "task"}`);
      }
      if (message.subtype === "task_notification") {
        const m = message as { status?: string; summary?: string; task_id?: string };
        const icon = m.status === "completed" ? "✅" : "❌";
        const summary = truncate(m.summary ?? "", 300);
        onProgress(`${icon} Agent ${m.status ?? "done"}: ${summary}`);
      }
    }

    // Fallback: grab session_id from any message
    if (!finalSessionId && "session_id" in message && message.session_id) {
      finalSessionId = message.session_id;
    }
  }

  return { response: result, sessionId: finalSessionId, cost, permissionDenials };
}
