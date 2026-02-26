import { Api, Context } from "grammy";
import { runSculptorAnalysis, executeSculptor } from "./claude";
import { withTrackedMutex } from "./updater";

// --- Config ---

const SCULPTOR_CHAT_ID = Number(process.env.SCULPTOR_CHAT_ID ?? -1003881403661);

const sculptorMessageIds = new Map<number, { sessionId: string }>();

export function isSculptorMessage(msgId: number): boolean {
  return sculptorMessageIds.has(msgId);
}

export function getSculptorSession(msgId: number): { sessionId: string } {
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

      const footer = "\nReply to continue the conversation.";
      let text = report + footer;
      if (text.length > 4000) {
        text = report.slice(0, 4000 - footer.length - 20) + "\n\n(truncated)" + footer;
      }

      const reportMsg = await botApi.sendMessage(chatId, text);

      // Register for reply routing (in-memory only)
      if (sculptorMessageIds.size > 100) {
        sculptorMessageIds.delete(sculptorMessageIds.keys().next().value!);
      }
      sculptorMessageIds.set(reportMsg.message_id, { sessionId });

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

export async function handleSculptorReply(ctx: Context, text: string, sessionId: string): Promise<void> {
  const msgId = ctx.msg!.message_id;
  const replyToId = ctx.msg!.reply_to_message!.message_id;

  console.log(`[sculptor] User replied: "${text.slice(0, 100)}", resuming session ${sessionId.slice(0, 8)}`);

  await withTrackedMutex(
    { api: ctx.api, chatId: ctx.chat!.id, replyTo: msgId, label: "🔧 Sculptor working…", errorPrefix: "🔧 Sculptor failed", tag: "sculptor-apply" },
    async (tracker) => {
      const result = await executeSculptor(text, sessionId, (line) => tracker.push(line));

      sculptorMessageIds.delete(replyToId);

      const response = result.response || "Done.";
      await tracker.finish("✅ Sculptor responded.");
      const responseMsg = await ctx.reply(response, {
        reply_parameters: { message_id: msgId },
      });

      // Register new message so David can keep the conversation going
      sculptorMessageIds.set(responseMsg.message_id, { sessionId: result.sessionId });
      console.log(`[sculptor] Response sent, message_id=${responseMsg.message_id} registered for follow-up`);
    },
  );
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
