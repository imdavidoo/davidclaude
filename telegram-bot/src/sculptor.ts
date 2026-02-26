import { Api, Context } from "grammy";
import { runSculptorAnalysis, executeSculptor } from "./claude";
import { withTrackedMutex } from "./updater";
import { readFile, writeFile, mkdir, rm } from "fs/promises";
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

      // Write pending.json so the approval flow works
      await mkdir(SCULPTOR_DIR, { recursive: true });
      const pendingData = {
        session_id: sessionId,
        timestamp: new Date().toISOString(),
        status: "notified",
        telegram_message_id: null as number | null,
      };

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

      pendingData.telegram_message_id = reportMsg.message_id;
      await writeFile(SCULPTOR_PENDING, JSON.stringify(pendingData, null, 2));

      await tracker.finish("✅ Sculptor analysis complete. See report below.");
      console.log(`[sculptor] Analysis complete, message_id=${reportMsg.message_id}`);
    },
  );
}

// --- Sculptor trigger via #sculptor ---

export async function handleSculptorTrigger(ctx: Context): Promise<void> {
  const msgId = ctx.msg!.message_id;
  const chatId = ctx.chat!.id;

  // Check if a sculptor analysis is already pending
  try {
    const raw = await readFile(SCULPTOR_PENDING, "utf-8");
    const data = JSON.parse(raw);
    if (data.status === "pending_review" || data.status === "notified") {
      await ctx.reply("A sculptor analysis is already pending. Reply to it or send \"skip\" first.", {
        reply_parameters: { message_id: msgId },
      });
      return;
    }
  } catch {
    // No pending file — good, proceed
  }

  console.log("[sculptor] Manual trigger via #sculptor");
  runSculptorStreaming(chatId, msgId);
}

// --- Sculptor reply handler ---

export async function handleSculptorReply(ctx: Context, text: string, pending: { sessionId: string }): Promise<void> {
  const msgId = ctx.msg!.message_id;

  // "skip" means dismiss
  if (text.trim().toLowerCase() === "skip") {
    await ctx.reply("Sculptor recommendations dismissed.", {
      reply_parameters: { message_id: msgId },
    });
    await rm(SCULPTOR_PENDING).catch(() => {});
    return;
  }

  console.log(`[sculptor] User replied: "${text.slice(0, 100)}", resuming session ${pending.sessionId.slice(0, 8)}`);

  await withTrackedMutex(
    { api: ctx.api, chatId: ctx.chat!.id, replyTo: msgId, label: "🔧 Applying sculptor changes…", errorPrefix: "🔧 Sculptor failed", tag: "sculptor-apply" },
    async (tracker) => {
      const result = await executeSculptor(text, pending.sessionId, (line) => tracker.push(line));
      await tracker.finish(`✅ Sculptor: ${result.response || "Done"}`);
      await rm(SCULPTOR_PENDING).catch(() => {});
    },
  );
}

// --- Re-register pending messages on startup ---

export async function restorePendingSculptor(): Promise<void> {
  try {
    const raw = await readFile(SCULPTOR_PENDING, "utf-8");
    const data = JSON.parse(raw);
    if (data.status === "notified" && data.telegram_message_id) {
      sculptorMessageIds.set(data.telegram_message_id, { sessionId: data.session_id });
      console.log(`[sculptor] Re-registered notified message_id=${data.telegram_message_id}`);
    }
  } catch {
    // No pending file — nothing to re-register
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
    // Check if already pending
    try {
      const raw = await readFile(SCULPTOR_PENDING, "utf-8");
      const data = JSON.parse(raw);
      if (data.status === "pending_review" || data.status === "notified") {
        console.log("[sculptor] Skipping daily run — analysis already pending");
        scheduleDailySculptor();
        return;
      }
    } catch {
      // No pending file — proceed
    }

    console.log("[sculptor] Starting daily scheduled run");
    runSculptorStreaming(SCULPTOR_CHAT_ID);
    scheduleDailySculptor();
  }, ms);
}
