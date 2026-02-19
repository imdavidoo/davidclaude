const MAX_LENGTH = 4096;

const HTML_ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>]/g, (ch) => HTML_ENTITIES[ch]);
}

export function splitMessage(text: string): string[] {
  if (text.length <= MAX_LENGTH) return [text];

  const parts: string[] = [];
  let remaining = text;

  while (remaining.length > MAX_LENGTH) {
    // Try to break at a newline, then space, then hard cut
    let splitAt = remaining.lastIndexOf("\n", MAX_LENGTH);
    if (splitAt <= 0) splitAt = remaining.lastIndexOf(" ", MAX_LENGTH);
    if (splitAt <= 0) splitAt = MAX_LENGTH;

    parts.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining) parts.push(remaining);
  return parts;
}
