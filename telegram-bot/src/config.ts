import path from "path";

export const CWD = "/home/imdavid/davidclaude";
export const CLAUDE_PATH = "/home/imdavid/.local/bin/claude";
export const UPLOAD_DIR = path.join(CWD, "uploads");

export const MODELS = {
  retrieval: "claude-haiku-4-5",
  updater: "claude-opus-4-6",
  sculptor: "claude-opus-4-6",
  transcription: "gpt-4o-transcribe",
} as const;

// Strip CLAUDECODE env var so child processes don't think they're nested
export const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => k !== "CLAUDECODE")
);
