import { Bot, Context } from "grammy";
import { sendMessage, retrieveContext } from "./claude";
import { getSession, setSessionId, isSeen, markSeen } from "./sessions";
import { splitMessage, markdownToTelegramHtml } from "./telegram";
import { transcribeAudio } from "./transcribe";
import { writeFile, mkdir, rm } from "fs/promises";

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

// Per-thread tracking of KB sections already loaded by the retrieval agent
const threadContext = new Map<number, string[]>();

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
  const isAutoForward = ctx.msg?.is_automatic_forward === true;

  const threadId = isAutoForward
    ? ctx.msg!.message_id
    : ctx.msg!.message_thread_id;

  if (!threadId) return;

  const mutex = getMutex(threadId);
  await mutex.acquire();

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

  try {
    // --- Retrieve KB context before main agent ---
    let enrichedText = text;
    try {
      onProgress("📚 Retrieving context…");
      const loaded = threadContext.get(threadId) ?? [];
      const retrieval = await retrieveContext(text, loaded, onProgress);
      if (retrieval.context) {
        enrichedText = `[Retrieved KB context]\n${retrieval.context}\n\n[User message]\n${text}`;
        threadContext.set(threadId, [...loaded, ...retrieval.sections]);
        onProgress(`📚 Loaded ${retrieval.sections.length} context section(s)`);
      } else {
        onProgress("📚 No additional context needed");
      }
    } catch (err) {
      console.error(`[thread:${threadId}] Retrieval failed:`, err);
      // Continue without context — don't block the response
    }

    const session = isAutoForward ? null : getSession(threadId);
    const result = await sendMessage(enrichedText, session?.session_id, onProgress);

    setSessionId(threadId, result.sessionId);

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

    console.log(
      `[thread:${threadId}] ${text.slice(0, 50)}... → $${result.cost.toFixed(4)}`
    );
  } catch (err) {
    if (progressTimer) clearTimeout(progressTimer);
    await ctx.api
      .deleteMessage(ctx.chat!.id, placeholder.message_id)
      .catch(() => {});

    const errMsg = err instanceof Error ? err.message : String(err);
    await ctx.reply(`Error: ${errMsg.slice(0, 1000)}`, replyOpts);
    console.error(`[thread:${threadId}] Error:`, err);
  } finally {
    clearInterval(typingInterval);
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

  try {
    // Save all images to disk
    for (const img of images) {
      const ext = img.mimeType.split("/")[1] ?? "jpg";
      const path = await saveImage(img.fileId, ext);
      savedPaths.push(path);
    }

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

  ctx.api
    .sendChatAction(ctx.chat!.id, "typing", { message_thread_id: threadId })
    .catch(() => {});

  try {
    const buffer = await downloadTelegramFile(fileId);
    const transcription = await transcribeAudio(buffer, filename);

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

// --- Message handlers ---

bot.on("message:text", (ctx) => handleMessage(ctx, ctx.msg.text));

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

  return processImage(ctx, largest.file_id, "image/jpeg", ctx.msg.caption);
});

bot.on("message:voice", (ctx) => {
  return processAudio(ctx, ctx.msg.voice.file_id, "voice.ogg");
});

bot.on("message:audio", (ctx) => {
  const audio = ctx.msg.audio;
  const ext = audio.mime_type?.split("/")[1] ?? "mp3";
  return processAudio(ctx, audio.file_id, audio.file_name ?? `audio.${ext}`);
});

bot.on("message:document", (ctx) => {
  const doc = ctx.msg.document;
  const mime = doc.mime_type ?? "";
  if (mime.startsWith("image/")) {
    return processImage(ctx, doc.file_id, mime, ctx.msg.caption);
  }
  if (mime.startsWith("audio/") || mime === "video/ogg") {
    return processAudio(ctx, doc.file_id, doc.file_name ?? "audio.ogg");
  }
});

// --- Start ---

bot.catch((err) => {
  console.error("Bot error:", err);
});

bot.start({
  onStart: () => console.log("Bot started"),
});
