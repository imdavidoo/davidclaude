import { Bot } from "grammy";
import { sendMessage } from "./claude";
import { getSession, setSessionId, addCost } from "./sessions";
import { splitMessage } from "./telegram";

// --- Config ---

const BOT_TOKEN = process.env.BOT_TOKEN;
const ALLOWED_CHAT_ID = Number(process.env.ALLOWED_CHAT_ID);
const ALLOWED_USER_IDS = (process.env.ALLOWED_USER_IDS ?? "")
  .split(",")
  .map(Number)
  .filter(Boolean);

if (!BOT_TOKEN) {
  console.error("BOT_TOKEN is required");
  process.exit(1);
}
if (!ALLOWED_CHAT_ID) {
  console.error("ALLOWED_CHAT_ID is required");
  process.exit(1);
}

const bot = new Bot(BOT_TOKEN);

// --- Per-thread mutex ---

class Mutex {
  private queue: Array<() => void> = [];
  private locked = false;

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    return new Promise<void>((resolve) => this.queue.push(resolve));
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
    }
  }
}

const mutexes = new Map<number, Mutex>();

function getMutex(threadId: number): Mutex {
  let m = mutexes.get(threadId);
  if (!m) {
    m = new Mutex();
    mutexes.set(threadId, m);
  }
  return m;
}

// --- Security middleware ---

bot.use((ctx, next) => {
  if (ctx.chat?.id !== ALLOWED_CHAT_ID) return;
  // Auto-forwarded channel posts: trust them (only channel admins can post)
  if (ctx.msg?.is_automatic_forward) return next();
  // Anonymous admin comments (posting as channel/group): only admins can do this
  if (ctx.msg?.sender_chat?.id === ALLOWED_CHAT_ID) return next();
  // Regular comments: check user ID
  if (!ALLOWED_USER_IDS.includes(ctx.from?.id ?? 0)) return;
  return next();
});

// --- Main message handler ---

bot.on("message:text", async (ctx) => {
  const isAutoForward = ctx.msg.is_automatic_forward === true;

  // Auto-forwarded = thread root (use message_id). Comments = thread child (use message_thread_id).
  const threadId = isAutoForward
    ? ctx.msg.message_id
    : ctx.msg.message_thread_id;

  // Ignore messages not in a thread and not auto-forwarded
  if (!threadId) return;

  const text = ctx.msg.text;

  const mutex = getMutex(threadId);
  await mutex.acquire();

  const replyOpts = { reply_parameters: { message_id: threadId } };

  // Send placeholder
  const placeholder = await ctx.reply("...", replyOpts);

  // Typing indicator every 4s
  const typingInterval = setInterval(() => {
    ctx.api
      .sendChatAction(ctx.chat.id, "typing", {
        message_thread_id: threadId,
      })
      .catch(() => {});
  }, 4000);

  // --- Live progress updates on placeholder ---
  const progressLines: string[] = [];
  let progressTimer: ReturnType<typeof setTimeout> | null = null;
  let placeholderDead = false;

  function flushProgress() {
    progressTimer = null;
    if (placeholderDead || progressLines.length === 0) return;
    let body = progressLines.join("\n");
    // Drop oldest lines to stay under Telegram's 4096 char limit
    while (body.length > 3800 && progressLines.length > 1) {
      progressLines.shift();
      body = "⋯ (earlier steps trimmed)\n" + progressLines.join("\n");
    }
    ctx.api
      .editMessageText(ctx.chat.id, placeholder.message_id, body)
      .catch((err: Error) => {
        const msg = err.message ?? "";
        if (
          msg.includes("message is not modified") ||
          msg.includes("message to edit not found")
        ) {
          if (msg.includes("not found")) placeholderDead = true;
          return;
        }
      });
  }

  function onProgress(line: string) {
    progressLines.push(line);
    if (!progressTimer) {
      // First line: flush quickly so user sees immediate activity
      const delay = progressLines.length === 1 ? 300 : 1500;
      progressTimer = setTimeout(flushProgress, delay);
    }
  }

  try {
    // Auto-forwarded = always fresh session. Comments = resume existing.
    const session = isAutoForward ? null : getSession(threadId);
    const result = await sendMessage(text, session?.session_id, onProgress);

    // Store session
    setSessionId(threadId, result.sessionId);
    addCost(threadId, result.cost);

    // Final flush of progress & delete placeholder
    if (progressTimer) clearTimeout(progressTimer);
    await ctx.api
      .deleteMessage(ctx.chat.id, placeholder.message_id)
      .catch(() => {});

    // Send response
    const parts = splitMessage(result.response || "(no response)");
    for (const part of parts) {
      await ctx.reply(part, replyOpts);
    }

    // Notify about permission denials
    for (const denial of result.permissionDenials) {
      const inputStr =
        typeof denial.input === "object"
          ? JSON.stringify(denial.input).slice(0, 200)
          : String(denial.input);
      await ctx.reply(
        `⚠️ Permission denied: Claude tried to use \`${denial.toolName}(${inputStr})\` which is not in the allowlist.`,
        { ...replyOpts, parse_mode: "Markdown" }
      );
    }

    console.log(
      `[thread:${threadId}] ${text.slice(0, 50)}... → $${result.cost.toFixed(4)}`
    );
  } catch (err) {
    // Clean up progress timer & delete placeholder
    if (progressTimer) clearTimeout(progressTimer);
    await ctx.api
      .deleteMessage(ctx.chat.id, placeholder.message_id)
      .catch(() => {});

    const errMsg = err instanceof Error ? err.message : String(err);
    await ctx.reply(`Error: ${errMsg.slice(0, 1000)}`, replyOpts);
    console.error(`[thread:${threadId}] Error:`, err);
  } finally {
    clearInterval(typingInterval);
    mutex.release();
  }
});

// --- Start ---

bot.catch((err) => {
  console.error("Bot error:", err);
});

bot.start({
  onStart: () => console.log("Bot started"),
});
