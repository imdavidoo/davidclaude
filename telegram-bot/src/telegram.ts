const MAX_LENGTH = 4096;

const HTML_ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>]/g, (ch) => HTML_ENTITIES[ch]);
}

export function markdownToTelegramHtml(md: string): string {
  const placeholders: { key: string; html: string }[] = [];
  let counter = 0;

  function placeholder(html: string): string {
    const key = `\x00PH${counter++}\x00`;
    placeholders.push({ key, html });
    return key;
  }

  let text = md;

  // 1. Fenced code blocks → <pre>
  text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
    const escaped = escapeHtml(code.replace(/\n$/, ""));
    return placeholder(
      lang
        ? `<pre><code class="language-${escapeHtml(lang)}">${escaped}</code></pre>`
        : `<pre>${escaped}</pre>`
    );
  });

  // 2. Inline code → <code>
  text = text.replace(/`([^`\n]+)`/g, (_m, code) => {
    return placeholder(`<code>${escapeHtml(code)}</code>`);
  });

  // 3. Blockquotes → <blockquote> (before HTML escape to match >)
  text = text.replace(/(^>\s?.+(?:\n>.*)*)/gm, (match) => {
    const content = match.replace(/^>\s?/gm, "");
    return placeholder(`<blockquote>${escapeHtml(content)}</blockquote>`);
  });

  // 4. Escape HTML in remaining text
  text = escapeHtml(text);

  // 5. Bold **text** → <b>
  text = text.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");

  // 6. Strikethrough ~~text~~ → <s>
  text = text.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // 7. Italic *text* (not matching ** which is already handled)
  text = text.replace(/(?<!\w)\*(?!\*)(.+?)(?<!\*)\*(?!\w)/g, "<i>$1</i>");

  // 8. Links [text](url) → <a>
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // 9. Headers → bold
  text = text.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");

  // 10. Bullet list markers → •
  text = text.replace(/^(\s*)[-*]\s/gm, "$1• ");

  // 11. Restore placeholders
  for (const { key, html } of placeholders) {
    text = text.replace(key, html);
  }

  return text;
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
