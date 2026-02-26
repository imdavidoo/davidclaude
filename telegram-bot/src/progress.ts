import { Api } from "grammy";

export interface ProgressTrackerOptions {
  /** Delay for the first progress flush (default: 1500ms). */
  firstFlushDelay?: number;
  /** Delay for subsequent progress flushes (default: 1500ms). */
  flushDelay?: number;
}

/**
 * Manages a Telegram placeholder message that shows live progress lines.
 * Handles debounced flushing, message truncation, and dead-message detection.
 */
export class ProgressTracker {
  private lines: string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dead = false;
  private firstFlushDelay: number;
  private flushDelay: number;

  constructor(
    private api: Api,
    private chatId: number,
    public readonly messageId: number,
    opts?: ProgressTrackerOptions,
  ) {
    this.firstFlushDelay = opts?.firstFlushDelay ?? 1500;
    this.flushDelay = opts?.flushDelay ?? 1500;
  }

  /** Create a tracker by sending an initial placeholder message. */
  static async create(
    api: Api,
    chatId: number,
    replyToMessageId: number,
    initialText: string,
    opts?: ProgressTrackerOptions,
  ): Promise<ProgressTracker> {
    const msg = await api.sendMessage(chatId, initialText, {
      reply_parameters: { message_id: replyToMessageId },
    });
    const tracker = new ProgressTracker(api, chatId, msg.message_id, opts);
    if (initialText) tracker.lines.push(initialText);
    return tracker;
  }

  /** Add a progress line. Triggers a debounced flush. */
  push(line: string): void {
    this.lines.push(line);
    if (!this.timer) {
      const delay = this.lines.length === 1 ? this.firstFlushDelay : this.flushDelay;
      this.timer = setTimeout(() => this.flush(), delay);
    }
  }

  /** Replace the placeholder content with final text. */
  async finish(text: string): Promise<void> {
    this.clearTimer();
    if (this.dead) return;
    await this.api
      .editMessageText(this.chatId, this.messageId, text.slice(0, 4000))
      .catch(() => {});
  }

  /** Delete the placeholder message. */
  async delete(): Promise<void> {
    this.clearTimer();
    await this.api.deleteMessage(this.chatId, this.messageId).catch(() => {});
  }

  /** Clean up the timer. Call this in finally blocks. */
  destroy(): void {
    this.clearTimer();
  }

  /** Whether the placeholder message has been deleted externally. */
  get isDead(): boolean {
    return this.dead;
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private flush(): void {
    this.timer = null;
    if (this.dead || this.lines.length === 0) return;
    let body = this.lines.join("\n");
    while (body.length > 3800 && this.lines.length > 1) {
      this.lines.shift();
      body = "⋯ (earlier steps trimmed)\n" + this.lines.join("\n");
    }
    this.api
      .editMessageText(this.chatId, this.messageId, body)
      .catch((err: Error) => {
        const msg = err.message ?? "";
        if (msg.includes("message is not modified") || msg.includes("message to edit not found")) {
          if (msg.includes("not found")) this.dead = true;
          return;
        }
      });
  }
}
