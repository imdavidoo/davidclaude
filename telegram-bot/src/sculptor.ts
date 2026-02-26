import { Api, Context } from "grammy";
import { runSculptorAnalysis, executeSculptor } from "./claude";
import { withTrackedMutex } from "./updater";
import { readFile, writeFile, mkdir } from "fs/promises";
import path from "path";
import { CWD } from "./config";

// --- Config ---

const SCULPTOR_DIR = path.join(CWD, ".sculptor");
const SCULPTOR_PENDING = path.join(SCULPTOR_DIR, "pending.json");
const SCULPTOR_CHAT_ID = Number(process.env.SCULPTOR_CHAT_ID ?? -1003881403661);

const sculptorMessageIds = new Map<number, { sessionId: string }>();

export function isSculptorMessage(msgId: number): boolean {
  return sculptorMessageIds.has(msgId);
}

export function getSculptorPending(msgId: number): { sessionId: string } {
  return sculptorMessageIds.get(msgId)!;
}

// --- Pending file helpers (stores multiple entries keyed by message ID) ---

interface PendingEntry {
  session_id: string;
  timestamp: string;
}

type PendingFile = Record<string, PendingEntry>;

async function readPending(): Promise<PendingFile> {
  try {
    return JSON.parse(await readFile(SCULPTOR_PENDING, "utf-8"));
  } catch {
    return {};
  }
}

async function savePendingEntry(messageId: number, sessionId: string): Promise<void> {
  await mkdir(SCULPTOR_DIR, { recursive: true });
  const pending = await readPending();
  pending[messageId] = { session_id: sessionId, timestamp: new Date().toISOString() };
  await writeFile(SCULPTOR_PENDING, JSON.stringify(pending, null, 2));
}

async function removePendingEntry(messageId: number): Promise<void> {
  const pending = await readPending();
  delete pending[messageId];
  await writeFile(SCULPTOR_PENDING, JSON.stringify(pending, null, 2));
}

// --- Init: needs bot.api for sending messages ---

let botApi: Api;

export function initSculptor(api: Api): void {
  botApi = api;
}

// --- Sculptor analysis with streaming ---

async function runSculptorStreaming(chatId: number, replyToMsgId?: number): Promise<void> {
  await withTrackedMutex(
    { api: botApi, chatId, replyTo: replyToMsgId, label: "🔍 Running KB Sculptor analysis…", errorPrefix: "🔍 Sculptor analysis failed", tag: "sculptor" },
    async (tracker) => {
      const result = await runSculptorAnalysis((line) => tracker.push(line));

      const report = result.response || "(No analysis available)";
      const sessionId = result.sessionId;

      // Send the report as a new message (reply-to-approve target)
      const footer = '\nReply to apply changes. Example: "apply all", "apply everything except X", or "skip"';
      let text = report + footer;
      if (text.length > 4000) {
        text = report.slice(0, 4000 - footer.length - 20) + "\n\n(truncated)" + footer;
      }

      const reportMsg = await botApi.sendMessage(chatId, text);

      // Register for reply routing
      if (sculptorMessageIds.size > 100) {
        sculptorMessageIds.delete(sculptorMessageIds.keys().next().value!);
      }
      sculptorMessageIds.set(reportMsg.message_id, { sessionId });

      await savePendingEntry(reportMsg.message_id, sessionId);

      await tracker.finish("✅ Sculptor analysis complete. See report below.");
      console.log(`[sculptor] Analysis complete, message_id=${reportMsg.message_id}`);
    },
  );
}

// --- Sculptor trigger via #sculptor ---

export async function handleSculptorTrigger(ctx: Context): Promise<void> {
  const msgId = ctx.msg!.message_id;
  const chatId = ctx.chat!.id;

  console.log("[sculptor] Manual trigger via #sculptor");
  runSculptorStreaming(chatId, msgId);
}

// --- Sculptor reply handler ---

export async function handleSculptorReply(ctx: Context, text: string, pending: { sessionId: string }): Promise<void> {
  const msgId = ctx.msg!.message_id;
  const replyToId = ctx.msg!.reply_to_message!.message_id;

  // "skip" or "done" ends the session
  const lower = text.trim().toLowerCase();
  if (lower === "skip" || lower === "done") {
    await ctx.reply("Sculptor session ended.", {
      reply_parameters: { message_id: msgId },
    });
    sculptorMessageIds.delete(replyToId);
    await removePendingEntry(replyToId);
    return;
  }

  console.log(`[sculptor] User replied: "${text.slice(0, 100)}", resuming session ${pending.sessionId.slice(0, 8)}`);

  await withTrackedMutex(
    { api: ctx.api, chatId: ctx.chat!.id, replyTo: msgId, label: "🔧 Sculptor working…", errorPrefix: "🔧 Sculptor failed", tag: "sculptor-apply" },
    async (tracker) => {
      const result = await executeSculptor(text, pending.sessionId, (line) => tracker.push(line));

      // Clean up old entry
      sculptorMessageIds.delete(replyToId);
      await removePendingEntry(replyToId);

      // Send response and register for further replies
      const response = result.response || "Done.";
      await tracker.finish("✅ Sculptor responded.");
      const responseMsg = await ctx.reply(response, {
        reply_parameters: { message_id: msgId },
      });

      // Register new message so David can keep the conversation going
      sculptorMessageIds.set(responseMsg.message_id, { sessionId: result.sessionId });
      await savePendingEntry(responseMsg.message_id, result.sessionId);
      console.log(`[sculptor] Response sent, message_id=${responseMsg.message_id} registered for follow-up`);
    },
  );
}

// --- Re-register pending messages on startup ---

const MAX_PENDING_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export async function restorePendingSculptor(): Promise<void> {
  const pending = await readPending();
  const now = Date.now();
  let pruned = false;

  for (const [msgId, entry] of Object.entries(pending)) {
    if (now - new Date(entry.timestamp).getTime() > MAX_PENDING_AGE_MS) {
      delete pending[msgId];
      pruned = true;
      console.log(`[sculptor] Pruned stale entry message_id=${msgId}`);
      continue;
    }
    sculptorMessageIds.set(Number(msgId), { sessionId: entry.session_id });
    console.log(`[sculptor] Re-registered pending message_id=${msgId}`);
  }

  if (pruned) {
    await writeFile(SCULPTOR_PENDING, JSON.stringify(pending, null, 2));
  }
}

// --- Daily scheduled run at 17:00 local time ---

export function scheduleDailySculptor(): void {
  const now = new Date();
  const target = new Date(now);
  target.setHours(17, 0, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);

  const ms = target.getTime() - now.getTime();
  console.log(`[sculptor] Next daily run scheduled in ${Math.round(ms / 60_000)} minutes`);

  setTimeout(async () => {
    console.log("[sculptor] Starting daily scheduled run");
    runSculptorStreaming(SCULPTOR_CHAT_ID);
    scheduleDailySculptor();
  }, ms);
}
