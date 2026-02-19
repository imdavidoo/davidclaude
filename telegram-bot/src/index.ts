import { Bot } from "grammy";
import { sendMessage } from "./claude";
import {
  getSession,
  setSessionId,
  deleteSession,
  addCost,
  getCost,
} from "./sessions";
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
  if (!ALLOWED_USER_IDS.includes(ctx.from?.id ?? 0)) return;
  return next();
});

// --- Commands ---

bot.command("reset", async (ctx) => {
  const threadId = ctx.msg.message_thread_id ?? 0;
  const deleted = deleteSession(threadId);
  await ctx.reply(deleted ? "Session cleared." : "No active session.", {
    message_thread_id: ctx.msg.message_thread_id,
  });
});

bot.command("cost", async (ctx) => {
  const threadId = ctx.msg.message_thread_id ?? 0;
  const cost = getCost(threadId);
  await ctx.reply(`Session cost: $${cost.toFixed(4)}`, {
    message_thread_id: ctx.msg.message_thread_id,
  });
});

// --- Main message handler ---

bot.on("message:text", async (ctx) => {
  const threadId = ctx.msg.message_thread_id ?? 0;
  const text = ctx.msg.text;

  const mutex = getMutex(threadId);
  await mutex.acquire();

  // Send placeholder
  const placeholder = await ctx.reply("...", {
    message_thread_id: ctx.msg.message_thread_id,
  });

  // Typing indicator every 4s
  const typingInterval = setInterval(() => {
    ctx.api
      .sendChatAction(ctx.chat.id, "typing", {
        message_thread_id: ctx.msg.message_thread_id,
      })
      .catch(() => {});
  }, 4000);

  try {
    const session = getSession(threadId);
    const result = await sendMessage(text, session?.session_id);

    // Store session
    setSessionId(threadId, result.sessionId);
    addCost(threadId, result.cost);

    // Delete placeholder
    await ctx.api
      .deleteMessage(ctx.chat.id, placeholder.message_id)
      .catch(() => {});

    // Send response
    const parts = splitMessage(result.response || "(no response)");
    for (const part of parts) {
      await ctx.reply(part, {
        message_thread_id: ctx.msg.message_thread_id,
      });
    }

    // Notify about permission denials
    for (const denial of result.permissionDenials) {
      const inputStr =
        typeof denial.input === "object"
          ? JSON.stringify(denial.input).slice(0, 200)
          : String(denial.input);
      await ctx.reply(
        `⚠️ Permission denied: Claude tried to use \`${denial.toolName}(${inputStr})\` which is not in the allowlist.`,
        {
          message_thread_id: ctx.msg.message_thread_id,
          parse_mode: "Markdown",
        }
      );
    }

    console.log(
      `[thread:${threadId}] ${text.slice(0, 50)}... → $${result.cost.toFixed(4)}`
    );
  } catch (err) {
    // Delete placeholder
    await ctx.api
      .deleteMessage(ctx.chat.id, placeholder.message_id)
      .catch(() => {});

    const errMsg = err instanceof Error ? err.message : String(err);
    await ctx.reply(`Error: ${errMsg.slice(0, 1000)}`, {
      message_thread_id: ctx.msg.message_thread_id,
    });
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
