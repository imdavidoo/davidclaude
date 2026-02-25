import { Bot, Context } from "grammy";
import { sendMessage, retrieveContext, updateKnowledgeBase, replyToUpdater } from "./claude";
import { getSession, setSessionId, setRetrievalSessionId, setFilterSessionId, setUpdaterSessionId, isSeen, markSeen } from "./sessions";
import { splitMessage, markdownToTelegramHtml } from "./telegram";
import { transcribeAudio } from "./transcribe";
import { getChannelConfig, getAllowedChatIds } from "./channels";
import { writeFile, mkdir, rm } from "fs/promises";
import { execSync } from "child_process";

const CWD = "/home/imdavid/davidclaude";

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

// --- Message flags (#q, #ds, #du) ---

interface MessageFlags {
  skipRetrieval: boolean;
  skipKBUpdate: boolean;
}

function parseFlags(text: string): { cleaned: string; flags: MessageFlags } {
  const flags: MessageFlags = { skipRetrieval: false, skipKBUpdate: false };
  let cleaned = text;

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

// --- Global KB updater (runs after main agent, one at a time) ---

const updaterMutex = new Mutex();

// Maps updater status message IDs -> thread IDs for reply routing
const updaterMessageIds = new Map<number, number>();

function fireKBUpdate(ctx: Context, text: string, threadId: number, sessionId?: string | null, mainAgentDiff?: string | null): void {
  console.log(`[updater:${threadId}] fireKBUpdate called`);
  (async () => {
    console.log(`[updater:${threadId}] waiting for mutex...`);
    await updaterMutex.acquire();
    console.log(`[updater:${threadId}] mutex acquired`);

    const replyOpts = { reply_parameters: { message_id: threadId } };
    let placeholder: { message_id: number } | null = null;
    const progressLines: string[] = ["📝 Updating knowledge base…"];
    let progressTimer: ReturnType<typeof setTimeout> | null = null;
    let placeholderDead = false;

    function flushUpdaterProgress() {
      progressTimer = null;
      if (!placeholder || placeholderDead || progressLines.length === 0) return;
      let body = progressLines.join("\n");
      while (body.length > 3800 && progressLines.length > 1) {
        progressLines.shift();
        body = "⋯ (earlier steps trimmed)\n" + progressLines.join("\n");
      }
      ctx.api
        .editMessageText(ctx.chat!.id, placeholder.message_id, body)
        .catch((err: Error) => {
          const msg = err.message ?? "";
          if (msg.includes("message is not modified") || msg.includes("message to edit not found")) {
            if (msg.includes("not found")) placeholderDead = true;
            return;
          }
        });
    }

    function onUpdaterProgress(line: string) {
      progressLines.push(line);
      if (!progressTimer) {
        progressTimer = setTimeout(flushUpdaterProgress, 1500);
      }
    }

    try {
      placeholder = await ctx.reply("📝 Updating knowledge base…", replyOpts);
      console.log(`[updater:${threadId}] placeholder sent, calling updateKnowledgeBase...`);

      const result = await updateKnowledgeBase(text, sessionId, onUpdaterProgress, mainAgentDiff);
      console.log(`[updater:${threadId}] updateKnowledgeBase returned: result="${result.result?.slice(0, 100)}", sessionId=${result.sessionId?.slice(0, 8)}`);
      if (result.sessionId) {
        setUpdaterSessionId(threadId, result.sessionId);
      }

      if (progressTimer) clearTimeout(progressTimer);

      // If nothing was persisted, delete the placeholder
      if (!result.result || result.result === "NOTHING") {
        if (placeholder) {
          await ctx.api.deleteMessage(ctx.chat!.id, placeholder.message_id).catch(() => {});
        }
      } else {
        // Show final summary (agent's last text output, not the progress log)
        const summary = `✅ ${result.result}`;
        if (placeholder && !placeholderDead) {
          await ctx.api
            .editMessageText(ctx.chat!.id, placeholder.message_id, summary.slice(0, 4000))
            .catch(() => {});
          // Register for reply routing
          if (updaterMessageIds.size > 500) {
            updaterMessageIds.delete(updaterMessageIds.keys().next().value!);
          }
          updaterMessageIds.set(placeholder.message_id, threadId);
        }
      }
    } catch (err) {
      if (progressTimer) clearTimeout(progressTimer);
      console.error(`[updater:${threadId}] KB update FAILED:`, err);
      const errMsg = err instanceof Error ? err.message : String(err);
      if (placeholder && !placeholderDead) {
        await ctx.api
          .editMessageText(ctx.chat!.id, placeholder.message_id, `📝 KB update failed: ${errMsg.slice(0, 200)}`)
          .catch(() => {});
      }
    } finally {
      updaterMutex.release();
    }
  })();
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
  const { cleaned, flags } = parseFlags(text);
  text = cleaned;

  const isAutoForward = ctx.msg?.is_automatic_forward === true;

  const threadId = isAutoForward
    ? ctx.msg!.message_id
    : ctx.msg!.message_thread_id;

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

  // Send placeholder
  const placeholder = await ctx.reply("...", replyOpts);

  // Typing indicator every 4s
  const typingInterval = setInterval(() => {
    ctx.api
      .sendChatAction(ctx.chat!.id, "typing", {
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
    while (body.length > 3800 && progressLines.length > 1) {
      progressLines.shift();
      body = "⋯ (earlier steps trimmed)\n" + progressLines.join("\n");
    }
    ctx.api
      .editMessageText(ctx.chat!.id, placeholder.message_id, body)
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
      const delay = progressLines.length === 1 ? 300 : 1500;
      progressTimer = setTimeout(flushProgress, delay);
    }
  }

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
      fireKBUpdate(ctx, text, threadId, kbSession?.updater_session_id, mainAgentDiff);
    }

    if (progressTimer) clearTimeout(progressTimer);
    await ctx.api
      .deleteMessage(ctx.chat!.id, placeholder.message_id)
      .catch(() => {});

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
    if (progressTimer) clearTimeout(progressTimer);
    await ctx.api
      .deleteMessage(ctx.chat!.id, placeholder.message_id)
      .catch(() => {});

    if (abortController.signal.aborted) {
      console.log(`[thread:${threadId}] Stopped by user`);
    } else {
      const errMsg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`Error: ${errMsg.slice(0, 1000)}`, replyOpts);
      console.error(`[thread:${threadId}] Error:`, err);
    }
  } finally {
    clearInterval(typingInterval);
    activeHandlers.delete(threadId);
    mutex.release();
  }
}

// --- Download file from Telegram ---

async function downloadTelegramFile(fileId: string): Promise<Buffer> {
  const file = await bot.api.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download file: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// --- Media group batching ---

interface MediaGroupEntry {
  ctx: Context;
  fileId: string;
  mimeType: string;
  caption?: string;
}

const mediaGroups = new Map<
  string,
  { entries: MediaGroupEntry[]; timer: ReturnType<typeof setTimeout> }
>();

const MEDIA_GROUP_WAIT_MS = 500;

function handleMediaGroupPhoto(
  mediaGroupId: string,
  ctx: Context,
  fileId: string,
  mimeType: string,
  caption: string | undefined
): void {
  let group = mediaGroups.get(mediaGroupId);
  if (!group) {
    group = {
      entries: [],
      timer: setTimeout(() => flushMediaGroup(mediaGroupId), MEDIA_GROUP_WAIT_MS),
    };
    mediaGroups.set(mediaGroupId, group);
  } else {
    clearTimeout(group.timer);
    group.timer = setTimeout(
      () => flushMediaGroup(mediaGroupId),
      MEDIA_GROUP_WAIT_MS
    );
  }
  group.entries.push({ ctx, fileId, mimeType, caption });
}

async function flushMediaGroup(mediaGroupId: string): Promise<void> {
  const group = mediaGroups.get(mediaGroupId);
  mediaGroups.delete(mediaGroupId);
  if (!group || group.entries.length === 0) return;

  const firstEntry = group.entries[0];
  const caption = group.entries.find((e) => e.caption)?.caption;
  const images = group.entries.map((e) => ({
    fileId: e.fileId,
    mimeType: e.mimeType,
  }));

  return processImages(firstEntry.ctx, images, caption);
}

// --- Save image to disk for Claude to read directly ---

const UPLOAD_DIR = "/home/imdavid/davidclaude/uploads";

async function saveImage(fileId: string, ext: string): Promise<string> {
  await mkdir(UPLOAD_DIR, { recursive: true });
  const path = `${UPLOAD_DIR}/${Date.now()}-${fileId.slice(-8)}.${ext}`;
  const buffer = await downloadTelegramFile(fileId);
  await writeFile(path, buffer);
  return path;
}

async function processImage(
  ctx: Context,
  fileId: string,
  mimeType: string,
  caption: string | undefined
): Promise<void> {
  return processImages(ctx, [{ fileId, mimeType }], caption);
}

async function processImages(
  ctx: Context,
  images: Array<{ fileId: string; mimeType: string }>,
  caption: string | undefined
): Promise<void> {
  const threadId = ctx.msg?.is_automatic_forward
    ? ctx.msg.message_id
    : ctx.msg?.message_thread_id;

  if (!threadId) return;

  const savedPaths: string[] = [];
  const generation = getStopGeneration(threadId);

  try {
    // Save all images to disk
    const tImg = Date.now();
    for (const img of images) {
      const ext = img.mimeType.split("/")[1] ?? "jpg";
      const path = await saveImage(img.fileId, ext);
      savedPaths.push(path);
    }
    console.log(`[thread:${threadId}] Image download: ${Date.now() - tImg}ms (${images.length} file${images.length > 1 ? "s" : ""})`);

    if (getStopGeneration(threadId) !== generation) return;

    const pathList = savedPaths.map((p) => `- ${p}`).join("\n");
    const count = savedPaths.length;
    const noun = count === 1 ? "an image" : `${count} images`;

    const prompt = caption
      ? `[User sent ${noun} with caption: "${caption}"]\n\nImage files (use Read tool to view):\n${pathList}`
      : `[User sent ${noun}]\n\nImage files (use Read tool to view):\n${pathList}`;

    await handleMessage(ctx, prompt);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await ctx.reply(`Error processing image: ${errMsg.slice(0, 1000)}`, {
      reply_parameters: { message_id: threadId },
    });
    console.error(`[thread:${threadId}] Image error:`, err);
  } finally {
    // Clean up saved files
    for (const p of savedPaths) {
      rm(p).catch(() => {});
    }
  }
}

// --- Process audio and build prompt for Claude ---

async function processAudio(
  ctx: Context,
  fileId: string,
  filename: string
): Promise<void> {
  const threadId = ctx.msg?.is_automatic_forward
    ? ctx.msg.message_id
    : ctx.msg?.message_thread_id;

  if (!threadId) return;

  const replyOpts = { reply_parameters: { message_id: threadId } };
  const statusMsg = await ctx.reply("transcribing...", replyOpts);

  const generation = getStopGeneration(threadId);

  try {
    const tAudio = Date.now();
    const buffer = await downloadTelegramFile(fileId);
    console.log(`[thread:${threadId}] Audio download: ${Date.now() - tAudio}ms (${(buffer.length / 1024).toFixed(0)}KB)`);
    const tTranscribe = Date.now();
    const transcription = await transcribeAudio(buffer, filename);
    console.log(`[thread:${threadId}] Transcription: ${Date.now() - tTranscribe}ms (${transcription.length} chars)`);

    await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id).catch(() => {});

    if (getStopGeneration(threadId) !== generation) return;

    const prompt = `[User sent a voice/audio message]\n\nTranscription:\n${transcription}`;

    await handleMessage(ctx, prompt);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await ctx.reply(`Error processing audio: ${errMsg.slice(0, 1000)}`, {
      reply_parameters: { message_id: threadId },
    });
    console.error(`[thread:${threadId}] Audio error:`, err);
  }
}

// --- Updater reply handler ---

async function handleUpdaterReply(ctx: Context, text: string, threadId: number): Promise<void> {
  const session = getSession(threadId);
  const updaterSessionId = session?.updater_session_id;

  if (!updaterSessionId) {
    return handleMessage(ctx, text);
  }

  console.log(`[updater-reply:${threadId}] acquiring mutex...`);
  await updaterMutex.acquire();
  console.log(`[updater-reply:${threadId}] mutex acquired`);

  const replyOpts = { reply_parameters: { message_id: threadId } };
  let placeholder: { message_id: number } | null = null;
  const progressLines: string[] = ["📝 Updating knowledge base…"];
  let progressTimer: ReturnType<typeof setTimeout> | null = null;
  let placeholderDead = false;

  function flushProgress() {
    progressTimer = null;
    if (!placeholder || placeholderDead || progressLines.length === 0) return;
    let body = progressLines.join("\n");
    while (body.length > 3800 && progressLines.length > 1) {
      progressLines.shift();
      body = "⋯ (earlier steps trimmed)\n" + progressLines.join("\n");
    }
    ctx.api
      .editMessageText(ctx.chat!.id, placeholder.message_id, body)
      .catch((err: Error) => {
        const msg = err.message ?? "";
        if (msg.includes("message is not modified") || msg.includes("message to edit not found")) {
          if (msg.includes("not found")) placeholderDead = true;
          return;
        }
      });
  }

  function onProgress(line: string) {
    progressLines.push(line);
    if (!progressTimer) {
      progressTimer = setTimeout(flushProgress, 1500);
    }
  }

  try {
    placeholder = await ctx.reply("📝 Updating knowledge base…", replyOpts);

    const result = await replyToUpdater(text, updaterSessionId, onProgress);

    if (result.sessionId) {
      setUpdaterSessionId(threadId, result.sessionId);
    }

    if (progressTimer) clearTimeout(progressTimer);

    if (!result.result || result.result === "NOTHING") {
      if (placeholder) {
        await ctx.api.deleteMessage(ctx.chat!.id, placeholder.message_id).catch(() => {});
      }
    } else {
      const summary = `✅ ${result.result}`;
      if (placeholder && !placeholderDead) {
        await ctx.api
          .editMessageText(ctx.chat!.id, placeholder.message_id, summary.slice(0, 4000))
          .catch(() => {});
        // Register for further replies
        if (updaterMessageIds.size > 500) {
          updaterMessageIds.delete(updaterMessageIds.keys().next().value!);
        }
        updaterMessageIds.set(placeholder.message_id, threadId);
      }
    }
  } catch (err) {
    if (progressTimer) clearTimeout(progressTimer);
    console.error(`[updater-reply:${threadId}] FAILED:`, err);
    const errMsg = err instanceof Error ? err.message : String(err);
    if (placeholder && !placeholderDead) {
      await ctx.api
        .editMessageText(ctx.chat!.id, placeholder.message_id, `📝 KB update failed: ${errMsg.slice(0, 200)}`)
        .catch(() => {});
    }
  } finally {
    updaterMutex.release();
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
  const replyToMsgId = ctx.msg.reply_to_message?.message_id;
  if (replyToMsgId && updaterMessageIds.has(replyToMsgId)) {
    const threadId = updaterMessageIds.get(replyToMsgId)!;
    handleUpdaterReply(ctx, ctx.msg.text, threadId);
    return;
  }
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

// --- Start ---

bot.catch((err) => {
  console.error("Bot error:", err);
});

bot.start({
  onStart: () => console.log("Bot started"),
});
