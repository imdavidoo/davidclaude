import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "sessions.db"));
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    thread_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    total_cost REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS seen_updates (
    update_id INTEGER PRIMARY KEY,
    seen_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// Clean up entries older than 1 day on startup
db.exec(`DELETE FROM seen_updates WHERE seen_at < datetime('now', '-1 day')`);

interface Session {
  session_id: string;
  total_cost: number;
}

export function getSession(threadId: number): Session | null {
  const row = db
    .prepare("SELECT session_id, total_cost FROM sessions WHERE thread_id = ?")
    .get(String(threadId)) as Session | undefined;
  return row ?? null;
}

export function setSessionId(threadId: number, sessionId: string): void {
  db.prepare(
    `INSERT INTO sessions (thread_id, session_id)
     VALUES (?, ?)
     ON CONFLICT(thread_id) DO UPDATE SET
       session_id = excluded.session_id,
       last_used_at = datetime('now')`
  ).run(String(threadId), sessionId);
}

export function addCost(threadId: number, cost: number): void {
  db.prepare(
    "UPDATE sessions SET total_cost = total_cost + ? WHERE thread_id = ?"
  ).run(cost, String(threadId));
}

export function isSeen(updateId: number): boolean {
  return !!db.prepare("SELECT 1 FROM seen_updates WHERE update_id = ?").get(updateId);
}

export function markSeen(updateId: number): void {
  db.prepare("INSERT OR IGNORE INTO seen_updates (update_id) VALUES (?)").run(updateId);
}

