import { Api, Context } from "grammy";
import { updateKnowledgeBase, replyToUpdater } from "./claude";
import { getSession, setUpdaterSessionId } from "./sessions";
import { ProgressTracker } from "./progress";

// --- Mutex (shared with index.ts for per-thread locking) ---

export class Mutex {
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

// --- Global KB updater mutex (one KB update at a time) ---

const updaterMutex = new Mutex();

// Maps updater status message IDs -> thread IDs for reply routing
const updaterMessageIds = new Map<number, number>();

export function isUpdaterMessage(msgId: number): boolean {
  return updaterMessageIds.has(msgId);
}

export function getUpdaterThreadId(msgId: number): number {
  return updaterMessageIds.get(msgId)!;
}

// --- Shared lifecycle: acquire updater mutex → create tracker → run fn → handle errors → release ---

export async function withTrackedMutex(
  opts: { api: Api; chatId: number; replyTo?: number; label: string; errorPrefix: string; tag: string },
  fn: (tracker: ProgressTracker) => Promise<void>,
): Promise<void> {
  await updaterMutex.acquire();
  const tracker = await ProgressTracker.create(opts.api, opts.chatId, opts.replyTo, opts.label);
  try {
    await fn(tracker);
  } catch (err) {
    console.error(`[${opts.tag}] Failed:`, err);
    const errMsg = err instanceof Error ? err.message : String(err);
    await tracker.finish(`${opts.errorPrefix}: ${errMsg.slice(0, 200)}`);
  } finally {
    tracker.destroy();
    updaterMutex.release();
  }
}

function finishUpdaterResult(
  tracker: ProgressTracker,
  result: { response: string; sessionId: string },
  threadId: number,
): Promise<void> {
  if (result.sessionId) {
    setUpdaterSessionId(threadId, result.sessionId);
  }
  if (!result.response || result.response === "NOTHING") {
    return tracker.delete();
  }
  if (updaterMessageIds.size > 500) {
    updaterMessageIds.delete(updaterMessageIds.keys().next().value!);
  }
  updaterMessageIds.set(tracker.messageId, threadId);
  return tracker.finish(`✅ ${result.response}`);
}

export function fireKBUpdate(ctx: Context, text: string, threadId: number, sessionId?: string | null, mainAgentDiff?: string | null, lastAIResponse?: string | null): void {
  console.log(`[updater:${threadId}] fireKBUpdate called`);
  withTrackedMutex(
    { api: ctx.api, chatId: ctx.chat!.id, replyTo: threadId, label: "📝 Updating knowledge base…", errorPrefix: "📝 KB update failed", tag: `updater:${threadId}` },
    async (tracker) => {
      const result = await updateKnowledgeBase(text, sessionId, (line) => tracker.push(line), mainAgentDiff, lastAIResponse);
      console.log(`[updater:${threadId}] updateKnowledgeBase returned: result="${result.response?.slice(0, 100)}", sessionId=${result.sessionId?.slice(0, 8)}`);
      await finishUpdaterResult(tracker, result, threadId);
    },
  );
}

export async function handleUpdaterReply(
  ctx: Context,
  text: string,
  threadId: number,
  fallbackHandleMessage: (ctx: Context, text: string) => Promise<void>,
): Promise<void> {
  const session = getSession(threadId);
  const updaterSessionId = session?.updater_session_id;

  if (!updaterSessionId) {
    return fallbackHandleMessage(ctx, text);
  }

  await withTrackedMutex(
    { api: ctx.api, chatId: ctx.chat!.id, replyTo: threadId, label: "📝 Updating knowledge base…", errorPrefix: "📝 KB update failed", tag: `updater-reply:${threadId}` },
    async (tracker) => {
      const result = await replyToUpdater(text, updaterSessionId, (line) => tracker.push(line));
      await finishUpdaterResult(tracker, result, threadId);
    },
  );
}
