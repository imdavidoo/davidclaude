import { Api, Context } from "grammy";
import { transcribeAudio } from "./transcribe";
import { writeFile, mkdir, rm } from "fs/promises";
import { UPLOAD_DIR } from "./config";

// --- Init: needs bot.api, BOT_TOKEN, and functions from index.ts ---

interface MediaDeps {
  botApi: Api;
  botToken: string;
  getThreadId: (ctx: Context) => number | undefined;
  getStopGeneration: (threadId: number) => number;
  handleMessage: (ctx: Context, text: string) => Promise<void>;
}

let deps: MediaDeps;

export function initMedia(d: MediaDeps): void {
  deps = d;
}

// --- Download file from Telegram ---

async function downloadTelegramFile(fileId: string): Promise<Buffer> {
  const file = await deps.botApi.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${deps.botToken}/${file.file_path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download file: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// --- Save image to disk for Claude to read directly ---

async function saveImage(fileId: string, ext: string): Promise<string> {
  await mkdir(UPLOAD_DIR, { recursive: true });
  const path = `${UPLOAD_DIR}/${Date.now()}-${fileId.slice(-8)}.${ext}`;
  const buffer = await downloadTelegramFile(fileId);
  await writeFile(path, buffer);
  return path;
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

export function handleMediaGroupPhoto(
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

// --- Image processing ---

export async function processImage(
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
  const threadId = deps.getThreadId(ctx);

  if (!threadId) return;

  let savedPaths: string[] = [];
  const generation = deps.getStopGeneration(threadId);

  try {
    // Save all images to disk in parallel
    const tImg = Date.now();
    savedPaths = await Promise.all(
      images.map(img => {
        const ext = img.mimeType.split("/")[1] ?? "jpg";
        return saveImage(img.fileId, ext);
      })
    );
    console.log(`[thread:${threadId}] Image download: ${Date.now() - tImg}ms (${images.length} file${images.length > 1 ? "s" : ""})`);

    if (deps.getStopGeneration(threadId) !== generation) return;

    const pathList = savedPaths.map((p) => `- ${p}`).join("\n");
    const count = savedPaths.length;
    const noun = count === 1 ? "an image" : `${count} images`;

    const prompt = caption
      ? `[User sent ${noun} with caption: "${caption}"]\n\nImage files (use Read tool to view):\n${pathList}`
      : `[User sent ${noun}]\n\nImage files (use Read tool to view):\n${pathList}`;

    await deps.handleMessage(ctx, prompt);
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

// --- Audio processing ---

export async function processAudio(
  ctx: Context,
  fileId: string,
  filename: string
): Promise<void> {
  const threadId = deps.getThreadId(ctx);

  if (!threadId) return;

  const replyOpts = { reply_parameters: { message_id: threadId } };
  const statusMsg = await ctx.reply("transcribing...", replyOpts);

  const generation = deps.getStopGeneration(threadId);

  try {
    const tAudio = Date.now();
    const buffer = await downloadTelegramFile(fileId);
    console.log(`[thread:${threadId}] Audio download: ${Date.now() - tAudio}ms (${(buffer.length / 1024).toFixed(0)}KB)`);
    const tTranscribe = Date.now();
    const transcription = await transcribeAudio(buffer, filename);
    console.log(`[thread:${threadId}] Transcription: ${Date.now() - tTranscribe}ms (${transcription.length} chars)`);

    await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id).catch(() => {});

    if (deps.getStopGeneration(threadId) !== generation) return;

    const prompt = `[User sent a voice/audio message]\n\nTranscription:\n${transcription}`;

    await deps.handleMessage(ctx, prompt);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await ctx.reply(`Error processing audio: ${errMsg.slice(0, 1000)}`, {
      reply_parameters: { message_id: threadId },
    });
    console.error(`[thread:${threadId}] Audio error:`, err);
  }
}
