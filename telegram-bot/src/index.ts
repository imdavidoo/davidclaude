import { Bot, Context } from "grammy";
import { sendMessage, retrieveContext, clearSelectedChunksStore } from "./claude";
import { getSession, setSessionId, setRetrievalSessionId, setFilterSessionId, isSeen, markSeen } from "./sessions";
import { splitMessage, markdownToTelegramHtml } from "./telegram";
import { getChannelConfig, getAllowedChatIds } from "./channels";
import { execSync } from "child_process";
import { CWD } from "./config";
import { ProgressTracker } from "./progress";
import { Mutex, fireKBUpdate, handleUpdaterReply, isUpdaterMessage, getUpdaterThreadId } from "./updater";
import { initSculptor, handleSculptorTrigger, handleSculptorReply, isSculptorMessage, getSculptorSession, scheduleDailySculptor } from "./sculptor";
import { initMedia, handleMediaGroupPhoto, processImage, processAudio } from "./media";

// --- Config ---

const BOT_TOKEN = process.env.BOT_TOKEN;
const ALLOWED_CHAT_IDS = getAllowedChatIds();
const ALLOWED_USER_IDS = (process.env.ALLOWED_USER_IDS ?? "")
  .split(",")
  .map(Number)
  .filter(Boolean);

if (!BOT_TOKEN) {
  console.error("BOT_TOKEN is required");
  process.exit(1);
}

const bot = new Bot(BOT_TOKEN);

// --- Initialize modules that need bot dependencies ---

initSculptor(bot.api);
initMedia({
  botApi: bot.api,
  botToken: BOT_TOKEN,
  getThreadId,
  getStopGeneration,
  handleMessage,
});
scheduleDailySculptor();

// --- Message flags (#q, #ds, #du) ---

interface MessageFlags {
  skipRetrieval: boolean;
  skipKBUpdate: boolean;
  triggerSculptor: boolean;
}

function parseFlags(text: string): { cleaned: string; flags: MessageFlags } {
  const flags: MessageFlags = { skipRetrieval: false, skipKBUpdate: false, triggerSculptor: false };
  let cleaned = text;

  if (/(?:^|\s)#sculptor(?:\s|$)/i.test(cleaned)) {
    flags.triggerSculptor = true;
    cleaned = cleaned.replace(/(?:^|\s)#sculptor(?:\s|$)/i, " ");
  }
  if (/(?:^|\s)#q(?:\s|$)/i.test(cleaned)) {
    flags.skipRetrieval = true;
    flags.skipKBUpdate = true;
    cleaned = cleaned.replace(/(?:^|\s)#q(?:\s|$)/i, " ");
  }
  if (/(?:^|\s)#ds(?:\s|$)/i.test(cleaned)) {
    flags.skipRetrieval = true;
    cleaned = cleaned.replace(/(?:^|\s)#ds(?:\s|$)/i, " ");
  }
  if (/(?:^|\s)#du(?:\s|$)/i.test(cleaned)) {
    flags.skipKBUpdate = true;
    cleaned = cleaned.replace(/(?:^|\s)#du(?:\s|$)/i, " ");
  }

  return { cleaned: cleaned.trim(), flags };
}

// --- Per-thread mutex ---

const mutexes = new Map<number, Mutex>();

function getMutex(threadId: number): Mutex {
  let m = mutexes.get(threadId);
  if (!m) {
    m = new Mutex();
    mutexes.set(threadId, m);
  }
  return m;
}

// --- Per-thread cancellation ---

interface ActiveHandler {
  abortController: AbortController;
  activeQuery: { close(): void } | null;
}

const activeHandlers = new Map<number, ActiveHandler>();
const stopGenerations = new Map<number, number>();

function getStopGeneration(threadId: number): number {
  return stopGenerations.get(threadId) ?? 0;
}

function getThreadId(ctx: Context): number | undefined {
  return ctx.msg?.is_automatic_forward ? ctx.msg.message_id : ctx.msg?.message_thread_id;
}

// --- Security middleware ---

bot.use((ctx, next) => {
  const chatId = ctx.chat?.id;
  if (!chatId || !ALLOWED_CHAT_IDS.has(chatId)) return;
  // Auto-forwarded channel posts: trust them (only channel admins can post)
  if (ctx.msg?.is_automatic_forward) return next();
  // Anonymous admin comments (posting as channel/group): only admins can do this
  if (ctx.msg?.sender_chat?.id === chatId) return next();
  // Regular comments: check user ID
  if (!ALLOWED_USER_IDS.includes(ctx.from?.id ?? 0)) return;
  return next();
});

// --- Dedup middleware (prevents crash-loop replays) ---

bot.use((ctx, next) => {
  const updateId = ctx.update.update_id;
  if (isSeen(updateId)) {
    console.log(`[dedup] Skipping already-seen update ${updateId}`);
    return;
  }
  markSeen(updateId);
  return next();
});

// --- Shared message handler ---

async function handleMessage(ctx: Context, text: string): Promise<void> {
  // --- Reply routing: sculptor/updater replies bypass normal flow ---
  const replyToMsgId = ctx.msg?.reply_to_message?.message_id;
  if (replyToMsgId && isUpdaterMessage(replyToMsgId)) {
    const threadId = getUpdaterThreadId(replyToMsgId);
    handleUpdaterReply(ctx, text, threadId, handleMessage);
    return;
  }
  if (replyToMsgId && isSculptorMessage(replyToMsgId)) {
    handleSculptorReply(ctx, text, getSculptorSession(replyToMsgId).sessionId);
    return;
  }

  const { cleaned, flags } = parseFlags(text);
  text = cleaned;

  if (flags.triggerSculptor) {
    handleSculptorTrigger(ctx);
    return;
  }

  const isAutoForward = ctx.msg?.is_automatic_forward === true;
  const threadId = getThreadId(ctx);
  if (!threadId) return;

  // Capture generation before acquiring mutex (for stop invalidation)
  const generation = getStopGeneration(threadId);

  const mutex = getMutex(threadId);
  await mutex.acquire();

  // If a stop happened while we were queued, bail out
  if (getStopGeneration(threadId) !== generation) {
    mutex.release();
    return;
  }

  // Set up cancellation for this handler
  const abortController = new AbortController();
  activeHandlers.set(threadId, { abortController, activeQuery: null });

  const channelConfig = getChannelConfig(ctx.chat!.id);
  const skipRetrieval = flags.skipRetrieval || channelConfig?.enableRetrieval === false;
  const skipKBUpdate = flags.skipKBUpdate || channelConfig?.enableKBUpdate === false;

  const replyOpts = { reply_parameters: { message_id: threadId } };

  // Send placeholder with progress tracking
  const tracker = await ProgressTracker.create(ctx.api, ctx.chat!.id, threadId, "...", { firstFlushDelay: 300 });
  const onProgress = (line: string) => tracker.push(line);

  // Typing indicator every 4s
  const typingInterval = setInterval(() => {
    ctx.api
      .sendChatAction(ctx.chat!.id, "typing", {
        message_thread_id: threadId,
      })
      .catch(() => {});
  }, 4000);

  const onQueryCreated = (q: { close(): void }) => {
    const handler = activeHandlers.get(threadId);
    if (handler) handler.activeQuery = q;
  };

  const tHandler = Date.now();
  try {
    // --- Retrieve KB context before main agent ---
    const session = isAutoForward ? null : getSession(threadId);
    let enrichedText = text;
    if (!skipRetrieval) {
      try {
        onProgress("── Retrieval ──");
        const tRetrieval = Date.now();
        const retrieval = await retrieveContext(text, session?.retrieval_session_id, session?.filter_session_id, onProgress, abortController, onQueryCreated);
        if (retrieval.plannerSessionId) {
          setRetrievalSessionId(threadId, retrieval.plannerSessionId);
        }
        if (retrieval.filterSessionId) {
          setFilterSessionId(threadId, retrieval.filterSessionId);
        }
        console.log(`[thread:${threadId}] Retrieval total: ${Date.now() - tRetrieval}ms`);
        if (retrieval.context) {
          enrichedText = `[Retrieved KB context]\n${retrieval.context}\n\n[User message]\n${text}`;
        }
      } catch (err) {
        if (abortController.signal.aborted) throw err;
        console.error(`[thread:${threadId}] Retrieval failed:`, err);
        onProgress("📚 Retrieval failed — continuing without context");
      }
    }

    // Check abort between retrieval and main agent
    if (abortController.signal.aborted) throw new Error("Cancelled");

    // Snapshot HEAD before main agent so we can diff its changes later
    let headBefore: string | null = null;
    try {
      headBefore = execSync("git rev-parse HEAD", { cwd: CWD, encoding: "utf-8", timeout: 5000 }).trim();
    } catch { /* not a git repo or error — fine */ }

    onProgress("── Responding ──");
    const tAgent = Date.now();
    const result = await sendMessage(enrichedText, session?.session_id, onProgress, channelConfig?.systemPrompt, abortController, onQueryCreated, channelConfig?.disallowedTools);
    console.log(`[thread:${threadId}] Main agent: ${Date.now() - tAgent}ms`);

    setSessionId(threadId, result.sessionId);

    // Diff everything the main agent changed (committed + uncommitted + untracked) against the pre-snapshot
    let mainAgentDiff: string | null = null;
    if (headBefore) {
      try {
        const parts: string[] = [];
        const diff = execSync(`git diff ${headBefore}`, { cwd: CWD, encoding: "utf-8", timeout: 5000 }).trim();
        if (diff) parts.push(diff);
        // git diff misses untracked files — capture those separately
        const untracked = execSync('git ls-files --others --exclude-standard -- "*.md"', { cwd: CWD, encoding: "utf-8", timeout: 5000 }).trim();
        if (untracked) parts.push(`New untracked files:\n${untracked}`);
        if (parts.length > 0) mainAgentDiff = parts.join("\n\n");
      } catch { /* no diff or git error — fine */ }
    }
    if (!skipKBUpdate) {
      const kbSession = getSession(threadId);
      fireKBUpdate(ctx, text, threadId, kbSession?.updater_session_id, mainAgentDiff, result.response);
    }

    await tracker.delete();

    const response = result.response || "(no response)";
    const htmlResponse = markdownToTelegramHtml(response);
    const parts = splitMessage(htmlResponse);
    for (const part of parts) {
      try {
        await ctx.reply(part, { ...replyOpts, parse_mode: "HTML" });
      } catch {
        // HTML parse failed — strip tags and send as plain text
        const plain = part.replace(/<[^>]+>/g, "");
        await ctx.reply(plain || part, replyOpts);
      }
    }

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

    console.log(`[thread:${threadId}] Total handler: ${Date.now() - tHandler}ms — ${text.slice(0, 50)}...`);
  } catch (err) {
    await tracker.delete();

    if (abortController.signal.aborted) {
      console.log(`[thread:${threadId}] Stopped by user`);
    } else {
      const errMsg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`Error: ${errMsg.slice(0, 1000)}`, replyOpts);
      console.error(`[thread:${threadId}] Error:`, err);
    }
  } finally {
    tracker.destroy();
    clearInterval(typingInterval);
    activeHandlers.delete(threadId);
    mutex.release();
  }
}

// --- Message handlers ---

bot.on("message:text", (ctx) => {
  const msgText = ctx.msg.text.trim().toLowerCase();

  // --- "stop" command: cancel in-progress processing ---
  if (msgText === "stop" || msgText === "/stop") {
    const threadId = ctx.msg.message_thread_id;
    if (!threadId) return;

    // Increment generation to invalidate queued handlers
    stopGenerations.set(threadId, getStopGeneration(threadId) + 1);

    // Abort the active handler
    const handler = activeHandlers.get(threadId);
    if (handler) {
      handler.abortController.abort();
      handler.activeQuery?.close();
    }

    return ctx.reply("Stopped.", {
      reply_parameters: { message_id: threadId },
    });
  }

  // --- Normal message routing (fire-and-forget so Grammy can process "stop" immediately) ---
  handleMessage(ctx, ctx.msg.text);
});

bot.on("message:photo", (ctx) => {
  const photo = ctx.msg.photo;
  const largest = photo[photo.length - 1];
  const mediaGroupId = ctx.msg.media_group_id;

  if (mediaGroupId) {
    handleMediaGroupPhoto(
      mediaGroupId,
      ctx,
      largest.file_id,
      "image/jpeg",
      ctx.msg.caption
    );
    return;
  }

  processImage(ctx, largest.file_id, "image/jpeg", ctx.msg.caption);
});

bot.on("message:voice", (ctx) => {
  processAudio(ctx, ctx.msg.voice.file_id, "voice.ogg");
});

bot.on("message:audio", (ctx) => {
  const audio = ctx.msg.audio;
  const ext = audio.mime_type?.split("/")[1] ?? "mp3";
  processAudio(ctx, audio.file_id, audio.file_name ?? `audio.${ext}`);
});

bot.on("message:document", (ctx) => {
  const doc = ctx.msg.document;
  const mime = doc.mime_type ?? "";
  if (mime.startsWith("image/")) {
    processImage(ctx, doc.file_id, mime, ctx.msg.caption);
    return;
  }
  if (mime.startsWith("audio/") || mime === "video/ogg") {
    processAudio(ctx, doc.file_id, doc.file_name ?? "audio.ogg");
  }
});

// --- Periodic cleanup of unbounded Maps (every hour) ---

setInterval(() => {
  // Clean mutexes and stopGenerations for threads with no active handler
  for (const threadId of mutexes.keys()) {
    if (!activeHandlers.has(threadId)) {
      mutexes.delete(threadId);
      stopGenerations.delete(threadId);
    }
  }
  // Clean selectedChunksStore (sessions expire naturally)
  clearSelectedChunksStore();
}, 60 * 60 * 1000);

// --- Start ---

bot.catch((err) => {
  console.error("Bot error:", err);
});

bot.start({
  onStart: () => console.log("Bot started"),
});
