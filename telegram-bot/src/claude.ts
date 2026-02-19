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

export async function sendMessage(
  text: string,
  sessionId?: string | null
): Promise<ClaudeResult> {
  const response = query({
    prompt: text,
    options: {
      cwd: CWD,
      pathToClaudeCodeExecutable: "/home/imdavid/.local/bin/claude",
      env: cleanEnv,
      systemPrompt: { type: "preset", preset: "claude_code" },
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

    // Fallback: grab session_id from any message
    if (!finalSessionId && "session_id" in message && message.session_id) {
      finalSessionId = message.session_id;
    }
  }

  return { response: result, sessionId: finalSessionId, cost, permissionDenials };
}
