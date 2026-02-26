import { query } from "@anthropic-ai/claude-agent-sdk";
import { readdir, readFile } from "fs/promises";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);
import path from "path";
import { CWD, CLAUDE_PATH, MODELS, cleanEnv } from "./config";

// --- Tool allowlists (composed from shared groups) ---

const BASE_READ_TOOLS = [
  "Read", "Glob", "Grep",
  "Bash(ls *)", "Bash(cat *)", "Bash(head *)", "Bash(tail *)", "Bash(wc *)", "Bash(find *)",
];

const KB_TOOLS = [
  "Bash(./kb-search *)", "Bash(./kb-index)", "Bash(./kb-recent *)", "Bash(./notify *)",
];

const FILE_WRITE_TOOLS = [
  "Write", "Edit", "Bash(mkdir *)", "Bash(mv *)",
];

const GIT_WRITE_TOOLS = [
  "Bash(git add *)", "Bash(git commit *)", "Bash(git status)", "Bash(git diff *)",
];

const ALLOWED_TOOLS = [
  ...BASE_READ_TOOLS, ...FILE_WRITE_TOOLS, ...KB_TOOLS,
  "Bash(git *)", "Task", "WebSearch", "WebFetch",
];

export interface PermissionDenial {
  toolName: string;
  input: unknown;
}

export interface ClaudeResult {
  response: string;
  sessionId: string;
  permissionDenials: PermissionDenial[];
}

function shortPath(p: string): string {
  return p.startsWith(CWD + "/") ? p.slice(CWD.length + 1) : p;
}

function formatToolUse(block: { name: string; input: Record<string, unknown> }): string {
  const { name, input } = block;
  switch (name) {
    case "Bash": {
      const cmd = String(input.command ?? "");
      const kbMatch = cmd.match(/\.\/kb-search\s+(.+)/);
      if (kbMatch) return `🔍 KB search: ${kbMatch[1]}`;
      if (cmd.includes("./kb-index")) return "📇 Re-indexing KB";
      if (cmd.includes("./kb-recent")) return "📅 Reading recent entries";
      if (cmd.includes("./notify")) return `📣 Notify: ${cmd.replace(/\.\/notify\s*/, "").slice(0, 120)}`;
      if (cmd.startsWith("git commit")) return `📦 Committing changes`;
      if (cmd.startsWith("git add")) return `📦 Staging files`;
      return `⚙️ ${cmd.slice(0, 120)}`;
    }
    case "Read":
      return `📄 Read ${shortPath(String(input.file_path ?? ""))}`;
    case "Task": {
      const desc = String(input.description ?? "");
      return `🤖 Agent: ${desc}`;
    }
    case "Grep":
      return `🔎 Grep: "${String(input.pattern ?? "")}" in ${shortPath(String(input.path ?? "."))}`;
    case "Glob":
      return `🔎 Glob: "${String(input.pattern ?? "")}" in ${shortPath(String(input.path ?? "."))}`;
    case "WebSearch":
      return `🌐 Search: "${String(input.query ?? "")}"`;
    case "WebFetch":
      return `🌐 Fetch: ${String(input.url ?? "")}`;
    case "Write":
      return `✏️ Write ${shortPath(String(input.file_path ?? ""))}`;
    case "Edit":
      return `✏️ Edit ${shortPath(String(input.file_path ?? ""))}`;
    case "TodoWrite":
    case "TaskCreate":
    case "TaskUpdate":
    case "TaskList":
      return `📋 ${name}`;
    default: {
      const firstVal = Object.values(input)[0];
      const valStr = typeof firstVal === "object" ? JSON.stringify(firstVal).slice(0, 100) : String(firstVal ?? "").slice(0, 100);
      return `🔧 ${name}: ${valStr}`;
    }
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

// Shared helper: consume an Agent SDK response stream, forward progress, return result
interface StreamOptions {
  onProgress?: (line: string) => void;
  abortController?: AbortController;
}

async function consumeAgentStream(
  response: AsyncIterable<Record<string, unknown>>,
  opts?: StreamOptions,
): Promise<ClaudeResult> {
  const { onProgress, abortController } = opts ?? {};
  let finalSessionId = "";
  let result = "";
  let permissionDenials: PermissionDenial[] = [];

  for await (const message of response) {
    const msg = message as Record<string, unknown>;
    if (abortController?.signal.aborted) break;

    // Capture session ID from init message
    if (msg.type === "system" && msg.subtype === "init") {
      finalSessionId = msg.session_id as string;
    }

    // Capture result
    if (msg.type === "result") {
      const denials = (msg.permission_denials ?? []) as Array<{ tool_name: string; tool_use_id: string; tool_input: unknown }>;
      permissionDenials = denials.map((d) => ({ toolName: d.tool_name, input: d.tool_input }));

      if (msg.subtype === "success") {
        result = msg.result as string;
      } else {
        const errors = (msg.errors ?? []) as string[];
        result = `Error (${msg.subtype}): ${errors.join("\n") || "Unknown error"}`;
      }
    }

    // Surface thinking + tool calls from assistant messages
    if (onProgress && msg.type === "assistant") {
      const isTopLevel = msg.parent_tool_use_id === null;
      const content = ((msg.message as Record<string, unknown>)?.content ?? []) as Array<{
        type: string; text?: string; name?: string; input?: Record<string, unknown>;
      }>;
      for (const block of content) {
        if (block.type === "text" && block.text && isTopLevel) {
          const t = block.text.trim();
          if (t) onProgress(`💭 ${truncate(t, 300)}`);
        }
        if (block.type === "tool_use" && block.name && block.input && isTopLevel) {
          onProgress(formatToolUse(block as { name: string; input: Record<string, unknown> }));
        }
      }
    }

    // Surface task lifecycle
    if (onProgress && msg.type === "system") {
      if (msg.subtype === "task_started") {
        onProgress(`🚀 Agent started: ${(msg.description as string) ?? "task"}`);
      }
      if (msg.subtype === "task_notification") {
        const icon = msg.status === "completed" ? "✅" : "❌";
        const summary = truncate((msg.summary as string) ?? "", 300);
        onProgress(`${icon} Agent ${(msg.status as string) ?? "done"}: ${summary}`);
      }
    }

    // Fallback: grab session_id from any message
    if (!finalSessionId && "session_id" in msg && msg.session_id) {
      finalSessionId = msg.session_id as string;
    }
  }

  if (abortController?.signal.aborted) throw new Error("Cancelled");

  return { response: result.trim(), sessionId: finalSessionId, permissionDenials };
}

// Shared helper: invoke a Claude agent with common base options
type SettingSource = "user" | "project" | "local";

interface AgentOptions {
  prompt: string;
  model?: string;
  systemPrompt?: string | { type: "preset"; preset: "claude_code"; append?: string };
  allowedTools?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
  resume?: string;
  settingSources?: SettingSource[];
  abortController?: AbortController;
  onQueryCreated?: (q: { close(): void }) => void;
  onProgress?: (line: string) => void;
}

async function invokeAgent(opts: AgentOptions): Promise<ClaudeResult> {
  const { prompt, onProgress, abortController, onQueryCreated, resume, ...agentOpts } = opts;
  const response = query({
    prompt,
    options: {
      ...agentOpts,
      cwd: CWD,
      pathToClaudeCodeExecutable: CLAUDE_PATH,
      env: cleanEnv,
      ...(resume ? { resume } : {}),
      ...(abortController ? { abortController } : {}),
    },
  });
  onQueryCreated?.(response);
  return consumeAgentStream(response, { onProgress, abortController });
}

function topicPrefix(tag: string, text: string): string {
  const cleaned = text
    .replace(/^\[User sent[^\]]*\]\s*/i, "")
    .replace(/^\[Retrieved KB context\][\s\S]*?\[User message\]\s*/i, "")
    .replace(/^Transcription:\s*/i, "");
  const topic = cleaned.replace(/\s+/g, " ").trim().split(" ").slice(0, 4).join(" ");
  return `[${tag}: ${truncate(topic, 30)}]`;
}

// --- Context retrieval (two-step: search planner + chunk filter) ---

interface KBChunk {
  id: string;       // "file.md §Section Name"
  file: string;     // "file.md"
  section: string;  // "Section Name"
  content: string;  // raw text of the chunk
}

function parseKBSearchResults(output: string): KBChunk[] {
  const chunks: KBChunk[] = [];
  // Match chunk headers like: [1] work/_index.md §PetRadar [L3-L12] (keyword: ...)
  const chunkPattern = /^\[(\d+)\]\s+(\S+\.md)\s+§(.+?)\s+\[L\d+-L\d+\]/gm;
  let match;
  const headers: Array<{ index: number; file: string; section: string; start: number }> = [];

  while ((match = chunkPattern.exec(output)) !== null) {
    headers.push({
      index: Number(match[1]),
      file: match[2],
      section: match[3].trim(),
      start: match.index + match[0].length,
    });
  }

  for (let i = 0; i < headers.length; i++) {
    const hdr = headers[i];
    const end = i + 1 < headers.length ? headers[i + 1].start - (headers[i + 1].start - output.lastIndexOf("\n", headers[i + 1].start)) : output.length;
    // Extract content between this header and the next
    const rawBlock = output.slice(hdr.start, i + 1 < headers.length ? output.lastIndexOf(`[${headers[i + 1].index}]`, end) : output.length);
    // Strip the "> " prefix from each line
    const content = rawBlock
      .split("\n")
      .filter(l => l.startsWith("> ") || l === ">")
      .map(l => l.startsWith("> ") ? l.slice(2) : "")
      .join("\n")
      .trim();

    if (content) {
      const id = `${hdr.file} §${hdr.section}`;
      chunks.push({ id, file: hdr.file, section: hdr.section, content });
    }
  }

  return chunks;
}

function splitMarkdownByH2(content: string, filename: string): KBChunk[] {
  const chunks: KBChunk[] = [];
  const lines = content.split("\n");
  let currentSection = "(top)";
  let currentLines: string[] = [];

  for (const line of lines) {
    const h2Match = line.match(/^##\s+(.+)/);
    if (h2Match) {
      // Flush previous section
      const text = currentLines.join("\n").trim();
      if (text) {
        const id = `${filename} §${currentSection}`;
        chunks.push({ id, file: filename, section: currentSection, content: text });
      }
      currentSection = h2Match[1].trim();
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }
  // Flush last section
  const text = currentLines.join("\n").trim();
  if (text) {
    const id = `${filename} §${currentSection}`;
    chunks.push({ id, file: filename, section: currentSection, content: text });
  }
  return chunks;
}

interface KBSearchResult {
  chunks: KBChunk[];
  error?: string;
}

async function runKBSearch(queryArgs: string): Promise<KBSearchResult> {
  try {
    const { stdout } = await execAsync(`./kb-search ${queryArgs}`, {
      cwd: CWD,
      encoding: "utf-8",
      timeout: 15000,
    });
    return { chunks: parseKBSearchResults(stdout) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[kb-search] Failed for ${queryArgs}: ${msg}`);
    return { chunks: [], error: msg };
  }
}

function extractKeywords(queries: string[]): string[] {
  const keywords: string[] = [];
  for (const q of queries) {
    const matches = q.match(/"([^"]+)"/g);
    if (matches) {
      for (const m of matches) {
        keywords.push(m.slice(1, -1).toLowerCase());
      }
    }
  }
  return [...new Set(keywords)];
}

function createChunkPreview(chunk: KBChunk, keywords: string[], maxChars = 500): string {
  if (chunk.content.length <= maxChars) return chunk.content;

  const lines = chunk.content.split("\n");
  const includedIndices = new Set<number>();

  // Always include first 3 lines
  for (let i = 0; i < Math.min(3, lines.length); i++) {
    includedIndices.add(i);
  }

  // Find lines containing keywords and include ±1 line of context
  for (let i = 0; i < lines.length; i++) {
    const lineLower = lines[i].toLowerCase();
    if (keywords.some(kw => lineLower.includes(kw))) {
      for (let j = Math.max(0, i - 1); j <= Math.min(lines.length - 1, i + 1); j++) {
        includedIndices.add(j);
      }
    }
  }

  // Build preview from included lines, inserting [...] for gaps
  const sorted = [...includedIndices].sort((a, b) => a - b);
  const parts: string[] = [];
  let charCount = 0;
  let prevIdx = -1;

  for (const idx of sorted) {
    if (charCount >= maxChars) break;
    if (prevIdx >= 0 && idx > prevIdx + 1) {
      parts.push("[…]");
    }
    parts.push(lines[idx]);
    charCount += lines[idx].length;
    prevIdx = idx;
  }

  if (sorted[sorted.length - 1] < lines.length - 1) {
    parts.push("[…]");
  }

  return parts.join("\n");
}

function deduplicateChunks(chunks: KBChunk[]): KBChunk[] {
  const seen = new Set<string>();
  return chunks.filter(c => {
    if (seen.has(c.id)) return false;
    seen.add(c.id);
    return true;
  });
}

/**
 * Re-read chunk content from the actual files on disk instead of using
 * potentially stale content from the vector index. Drops chunks whose
 * section no longer exists in the current file.
 */
async function resolveChunksFromDisk(chunks: KBChunk[]): Promise<KBChunk[]> {
  // Group chunks by file so we only read each file once
  const byFile = new Map<string, KBChunk[]>();
  for (const c of chunks) {
    const list = byFile.get(c.file) ?? [];
    list.push(c);
    byFile.set(c.file, list);
  }

  const resolved: KBChunk[] = [];

  for (const [file, fileChunks] of byFile) {
    let fileContent: string;
    try {
      fileContent = await readFile(path.join(CWD, file), "utf-8");
    } catch {
      // File no longer exists — skip all its chunks
      continue;
    }

    // Split file into sections by H2
    const diskSections = splitMarkdownByH2(fileContent, file);
    const sectionMap = new Map(diskSections.map(s => [s.id, s]));

    for (const chunk of fileChunks) {
      const diskVersion = sectionMap.get(chunk.id);
      if (diskVersion && diskVersion.content) {
        resolved.push({ ...chunk, content: diskVersion.content });
      }
      // If section doesn't exist on disk anymore, silently drop it
    }
  }

  return resolved;
}

const SEARCH_PLANNER_PROMPT = `You help find relevant background information for a user's message from his personal knowledge base. The KB is searched using: ./kb-search "term1" "term2" — a hybrid vector + keyword search. Related terms in one search boost each other; unrelated topics need separate searches.

Given a message from David, think about what background context would be useful to have. What people, relationships, history, patterns, projects, or preferences are relevant? What are you curious about that might already be documented?

Output one search query per line, formatted as kb-search arguments: "term1" "term2" "term3"
If the message is trivial (greetings, "thanks", yes/no) or needs no background context, respond with exactly: NONE
On follow-up messages: if existing context already covers this, respond with: NONE`;

const CHUNK_FILTER_PROMPT = `You select which knowledge base chunks are relevant to a user's message. You will be given numbered chunks and a user message. Respond with ONLY the chunk IDs that contain useful background context, one per line. If none are relevant, respond with: NONE

Rules:
- Select chunks that provide useful BACKGROUND context (who people are, history, existing patterns, preferences, etc.)
- Do NOT select chunks just because they mention the same words — they must add genuinely useful context
- Be selective — only include chunks that would meaningfully help a response`;

export interface RetrievalResult {
  context: string;
  plannerSessionId: string;
  filterSessionId: string;
  selectedChunks: Set<string>;
}

// In-memory store for selected chunks per filter session
const selectedChunksStore = new Map<string, Set<string>>();

export function getSelectedChunks(filterSessionId: string): Set<string> {
  return selectedChunksStore.get(filterSessionId) ?? new Set();
}

/** Clear the selected chunks store (called periodically to prevent memory leaks). */
export function clearSelectedChunksStore(): void {
  selectedChunksStore.clear();
}

async function queryNoTools(
  prompt: string,
  systemPrompt: string,
  sessionId?: string | null,
  abortController?: AbortController,
  onQueryCreated?: (q: { close(): void }) => void,
): Promise<{ result: string; sessionId: string }> {
  const { response: result, sessionId: finalSessionId } = await invokeAgent({
    prompt,
    model: MODELS.retrieval,
    systemPrompt,
    allowedTools: [],
    maxTurns: 1,
    resume: sessionId ?? undefined,
    abortController,
    onQueryCreated,
  });
  return { result, sessionId: finalSessionId };
}

export async function retrieveContext(
  text: string,
  plannerSessionId?: string | null,
  filterSessionId?: string | null,
  onProgress?: (line: string) => void,
  abortController?: AbortController,
  onQueryCreated?: (q: { close(): void }) => void,
): Promise<RetrievalResult> {
  const log = (msg: string) => console.log(`[retrieval] ${msg}`);
  const tStart = Date.now();
  const previouslySelected = filterSessionId ? getSelectedChunks(filterSessionId) : new Set<string>();
  log(`Start — plannerSession=${plannerSessionId?.slice(0, 8) ?? "none"}, filterSession=${filterSessionId?.slice(0, 8) ?? "none"}, previouslySelected=${previouslySelected.size}`);

  // --- Step 1: Ask planner for search queries ---
  const plannerPrompt = plannerSessionId
    ? `"${text}"\n\nAre there significantly new topics that need KB searches? If existing context covers this, respond: NONE\nOtherwise, output search queries (one per line).`
    : `${topicPrefix("Retrieval", text)} "${text}"\n\nWhat background context would be useful? Output search queries.`;

  onProgress?.("🧠 Planning searches…");
  const t0 = Date.now();
  const planResult = await queryNoTools(plannerPrompt, SEARCH_PLANNER_PROMPT, plannerSessionId, abortController, onQueryCreated);
  const newPlannerSessionId = planResult.sessionId;
  const plannerMs = Date.now() - t0;
  log(`Planner completed in ${plannerMs}ms`);
  log(`Planner raw output:\n${planResult.result}`);
  onProgress?.(`🧠 Planner done (${(plannerMs / 1000).toFixed(1)}s)`);

  if (planResult.result === "NONE" || !planResult.result) {
    log("Planner said NONE — skipping");
    onProgress?.("📚 No new searches needed");
    return { context: "", plannerSessionId: newPlannerSessionId, filterSessionId: filterSessionId ?? "", selectedChunks: previouslySelected };
  }

  // Parse search queries from planner output
  const queries = planResult.result
    .split("\n")
    .map(l => l.trim())
    .filter(l => l && l !== "NONE" && l.includes('"'));

  log(`Parsed ${queries.length} queries: ${JSON.stringify(queries)}`);

  // --- Step 2: Run searches in code + read recent/ daily files ---
  let allChunks: KBChunk[] = [];

  // Include recent daily files only on first retrieval (they don't change between messages)
  if (!filterSessionId) {
    const tRecent = Date.now();
    try {
      const recentDir = path.join(CWD, "recent");
      const recentFiles = await readdir(recentDir);
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - 7);
      const cutoffStr = cutoff.toISOString().slice(0, 10);

      const dateFiles = recentFiles
        .filter(f => f !== "_index.md" && f.endsWith(".md") && /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
        .filter(f => f.slice(0, 10) >= cutoffStr)
        .sort()
        .reverse();

      for (const f of dateFiles) {
        const content = await readFile(path.join(recentDir, f), "utf-8");
        const chunks = splitMarkdownByH2(content, `recent/${f}`);
        log(`recent/${f} → ${chunks.length} chunks: ${chunks.map(c => c.id).join(", ")}`);
        allChunks.push(...chunks);
      }
    } catch { /* no recent/ directory */ }
    log(`Recent files loaded in ${Date.now() - tRecent}ms`);
  }

  // Check abort before running searches
  if (abortController?.signal.aborted) throw new Error("Cancelled");

  // Run all search queries in parallel
  for (const q of queries) {
    onProgress?.(`🔍 KB search: ${q}`);
  }
  const t2 = Date.now();
  const searchResults = await Promise.all(
    queries.map(async q => {
      const { chunks, error } = await runKBSearch(q);
      if (error) {
        onProgress?.(`⚠️ Search failed: ${q}`);
      }
      log(`Search ${q} → ${chunks.length} chunks: ${chunks.map(c => c.id).join(", ")}${error ? ` (error: ${error.slice(0, 100)})` : ""}`);
      return chunks;
    })
  );
  const searchMs = Date.now() - t2;
  log(`All searches completed in ${searchMs}ms`);
  for (const results of searchResults) {
    allChunks.push(...results);
  }
  onProgress?.(`🔍 Searches done (${(searchMs / 1000).toFixed(1)}s)`);

  log(`Total raw chunks before dedup: ${allChunks.length}`);

  // Deduplicate and filter out already-selected chunks
  allChunks = deduplicateChunks(allChunks);
  log(`After dedup: ${allChunks.length}`);

  // Re-read content from disk (index may be stale)
  const tResolve = Date.now();
  allChunks = await resolveChunksFromDisk(allChunks);
  log(`Disk resolve: ${Date.now() - tResolve}ms — ${allChunks.length} chunks (dropped ${allChunks.length === 0 ? "all" : ""} stale)`);

  const newChunks = allChunks.filter(c => !previouslySelected.has(c.id));
  log(`After filtering previously-selected: ${newChunks.length} (removed ${allChunks.length - newChunks.length})`);

  if (newChunks.length === 0) {
    onProgress?.("📚 No new context found");
    return { context: "", plannerSessionId: newPlannerSessionId, filterSessionId: filterSessionId ?? "", selectedChunks: previouslySelected };
  }

  // Check abort before starting filter
  if (abortController?.signal.aborted) throw new Error("Cancelled");

  // --- Step 3: Ask filter which chunks are relevant (separate session) ---
  const keywords = extractKeywords(queries);
  const chunkList = newChunks
    .map(c => `[${c.id}]\n${createChunkPreview(c, keywords)}`)
    .join("\n\n---\n\n");

  const filterPrompt = `${filterSessionId ? "" : topicPrefix("Filter", text) + " "}"${text}"\n\nChunks found (${newChunks.length} total, showing previews):\n\n${chunkList}\n\nWhich chunk IDs are relevant? Respond with one ID per line (format: "file.md §Section Name"). If none, respond: NONE`;

  log(`Sending ${newChunks.length} chunks to filter (IDs: ${newChunks.map(c => c.id).join(", ")})`);
  onProgress?.(`🧠 Filtering ${newChunks.length} chunks…`);
  const t3 = Date.now();
  const filterResult = await queryNoTools(filterPrompt, CHUNK_FILTER_PROMPT, filterSessionId, abortController, onQueryCreated);
  const newFilterSessionId = filterResult.sessionId;
  const filterMs = Date.now() - t3;
  log(`Filter completed in ${filterMs}ms`);
  onProgress?.(`🧠 Filter done (${(filterMs / 1000).toFixed(1)}s)`);
  log(`Filter raw output:\n${filterResult.result}`);

  if (filterResult.result === "NONE" || !filterResult.result) {
    log("Filter said NONE — no relevant context");
    onProgress?.("📚 No relevant context found");
    return { context: "", plannerSessionId: newPlannerSessionId, filterSessionId: newFilterSessionId, selectedChunks: previouslySelected };
  }

  // Parse selected IDs from filter output
  const selectedLines = filterResult.result
    .split("\n")
    .map(l => l.trim())
    .filter(l => l && l !== "NONE");

  log(`Filter selected ${selectedLines.length} lines: ${JSON.stringify(selectedLines)}`);

  // Match selected lines to actual chunks (fuzzy match on the ID)
  const chunkMap = new Map(newChunks.map(c => [c.id, c]));
  const selectedNow: KBChunk[] = [];

  for (const line of selectedLines) {
    // Try exact match first
    if (chunkMap.has(line)) {
      log(`  Exact match: "${line}"`);
      selectedNow.push(chunkMap.get(line)!);
      continue;
    }
    // Fuzzy: find chunk whose ID is contained in the line or vice versa
    let matched = false;
    for (const [id, chunk] of chunkMap) {
      if (line.includes(id) || id.includes(line)) {
        log(`  Fuzzy match: "${line}" → "${id}"`);
        selectedNow.push(chunk);
        matched = true;
        break;
      }
    }
    if (!matched) {
      log(`  NO MATCH for: "${line}"`);
    }
  }

  log(`Final selected: ${selectedNow.length} chunks: ${selectedNow.map(c => c.id).join(", ")}`);

  // Update selected chunks set
  const updatedSelected = new Set(previouslySelected);
  for (const c of selectedNow) {
    updatedSelected.add(c.id);
  }
  selectedChunksStore.set(newFilterSessionId, updatedSelected);

  // Assemble context from real chunk content
  const context = selectedNow
    .map(c => `[${c.file} ## ${c.section}]\n${c.content}`)
    .join("\n\n---\n\n");

  const files = [...new Set(selectedNow.map(c => c.file))];
  log(`Context assembled: ${context.length} chars from ${files.join(", ")}`);
  const totalMs = Date.now() - tStart;
  log(`Total retrieval time: ${totalMs}ms`);
  onProgress?.(`📚 ${selectedNow.length}/${newChunks.length} chunks selected (${(totalMs / 1000).toFixed(1)}s total)`);

  return { context, plannerSessionId: newPlannerSessionId, filterSessionId: newFilterSessionId, selectedChunks: updatedSelected };
}

// --- KB Updater agent ---

const UPDATER_TOOLS = [
  ...BASE_READ_TOOLS, ...FILE_WRITE_TOOLS, ...KB_TOOLS, ...GIT_WRITE_TOOLS,
];

function buildUpdaterPrompt(): string {
  return `You are a knowledge base curator for David's personal knowledge base. Your job is to extract key information from David's messages and persist it to the KB.

The knowledge base is in the current working directory (${CWD}).

**How to search:**
- Run: ./kb-search "term1" "term2" "term3" — hybrid vector + keyword search across all KB files
- Multiple related terms in ONE search boost each other.
- Use SEPARATE searches for unrelated topics.

**Core principles:**
- For each piece of new information: search the KB to find where related content already exists, then SCULPT AND POLISH the existing content rather than appending raw text
- Only create new files/sections when the information genuinely doesn't belong anywhere existing
- Actively restructure: create/rename directories, reorganize files, update _index.md files when the structure evolves
- After any file changes, run \`./kb-index\` to keep the vector index fresh
- After structural changes (moved/renamed files, new directories), run \`./notify "summary of what changed"\` to inform David via Telegram

**Recent memory:**
- Daily files live at \`recent/YYYY-MM-DD.md\` (use today's date: \`recent/${new Date().toISOString().slice(0, 10)}.md\`)
- Read today's file before writing — sculpt and update existing content, don't duplicate
- \`./kb-recent\` shows the last 7 days (or \`./kb-recent N\` for N days)
- Old files age out naturally — no need to delete them

**What to persist:**
- Facts about people, relationship dynamics, life updates
- Plans, decisions, reflections, insights
- Changed circumstances, new preferences
- Project details, work developments

**What NOT to persist:**
- The bot's own ideas, suggestions, reflections, or analysis — NEVER persist these even if David agrees with them
- Casual or low-conviction responses to AI-prompted topics — if David is clearly just answering a question rather than sharing a genuine belief, skip it
- Transient moods ("I'm tired"), trivial exchanges ("thanks", "ok")
- Greetings, small talk, acknowledgements
- Anything the main assistant already handled (if a diff is provided, those changes are already done — don't redo them)

**Judging conviction level:**
When an AI message is included for context, use it to assess how much weight David's response carries:
- David spontaneously shares something → high conviction, persist
- AI asked about a topic and David gives a thoughtful, detailed response → genuine reflection, persist
- AI asked about a topic and David gives a brief/dismissive answer ("I don't really care but I guess...") → low conviction, skip

**Committing changes:**
- After making KB changes (and running \`./kb-index\`), commit all KB .md files you changed or created
- Also commit any untracked .md KB files that the main assistant created (check \`git status\` for untracked .md files in KB directories)
- Use \`git add <specific files>\` — never \`git add -A\` or \`git add .\`
- Commit message format: \`KB: <short description of what changed>\`
- Example: \`KB: Update Tom dynamics, add burnout insight\`
- Do NOT commit non-KB files (code, configs, etc.). Only commit .md files in KB directories.

If nothing in the message is worth persisting, respond with exactly: NOTHING`;
}


export async function replyToUpdater(
  text: string,
  sessionId: string,
  onProgress?: (line: string) => void,
): Promise<ClaudeResult> {
  return invokeAgent({
    prompt: `David replies to your last KB update: "${text}"\n\nFollow his instruction.`,
    model: MODELS.updater,
    systemPrompt: buildUpdaterPrompt(),
    allowedTools: UPDATER_TOOLS,
    disallowedTools: ["Task", "WebSearch", "WebFetch"],
    maxTurns: 30,
    settingSources: ["project", "local"],
    resume: sessionId,
    onProgress,
  });
}

// --- Sculptor analysis (triggered via #sculptor in Telegram) ---

export async function runSculptorAnalysis(
  onProgress?: (line: string) => void,
): Promise<ClaudeResult> {
  return invokeAgent({
    prompt: await readFile(path.join(CWD, "sculptor-prompt.md"), "utf-8"),
    model: MODELS.sculptor,
    allowedTools: [
      "Read", "Glob", "Grep", "Task",
      "Bash(./kb-search *)", "Bash(./kb-recent *)",
      "Bash(ls *)", "Bash(cat *)", "Bash(head *)", "Bash(tail *)",
    ],
    disallowedTools: ["Write", "Edit", "WebSearch", "WebFetch"],
    maxTurns: 50,
    settingSources: ["project", "local"],
    onProgress,
  });
}

// --- Sculptor execution (resumes analysis session to apply approved changes) ---

export async function executeSculptor(
  userApproval: string,
  sessionId: string,
  onProgress?: (line: string) => void,
): Promise<ClaudeResult> {
  return invokeAgent({
    prompt: `David reviewed your recommendations and replied:

"${userApproval}"

Apply the changes David approved. Read each file immediately before editing (your earlier reads may be stale).

After all changes: run ./kb-index once, then git add and commit with message "KB Sculptor: <short summary>".`,
    model: MODELS.sculptor,
    allowedTools: [...UPDATER_TOOLS, "Bash(rm *)", "Bash(git rm *)"],
    disallowedTools: ["Task", "WebSearch", "WebFetch"],
    maxTurns: 50,
    settingSources: ["project", "local"],
    resume: sessionId,
    onProgress,
  });
}

export async function updateKnowledgeBase(
  text: string,
  sessionId?: string | null,
  onProgress?: (line: string) => void,
  mainAgentDiff?: string | null,
  lastAIResponse?: string | null,
): Promise<ClaudeResult> {
  const diffContext = mainAgentDiff
    ? `\n\nThe main assistant already handled David's explicit request and made these file changes:\n\`\`\`diff\n${mainAgentDiff}\n\`\`\`\nDo NOT duplicate these changes. Focus on any additional implicit knowledge (facts about people, preferences, plans, relationship dynamics, etc.) that wasn't already captured above.`
    : "";

  const aiContext = lastAIResponse
    ? `[Last AI message — for context only, do NOT persist anything from this]\n${lastAIResponse}\n\n`
    : "";

  const prompt = sessionId
    ? `${aiContext}[David's message]\n"${text}"${diffContext}\n\nExtract any key new information. You already know what was previously processed.`
    : `${topicPrefix("KB Updater", text)} ${aiContext}[David's message]\n"${text}"${diffContext}\n\nExtract any key information worth persisting to the knowledge base.`;

  return invokeAgent({
    prompt,
    model: MODELS.updater,
    systemPrompt: buildUpdaterPrompt(),
    allowedTools: UPDATER_TOOLS,
    disallowedTools: ["Task", "WebSearch", "WebFetch"],
    maxTurns: 30,
    settingSources: ["project", "local"],
    resume: sessionId ?? undefined,
    onProgress,
  });
}

// --- Main agent ---

export async function sendMessage(
  text: string,
  sessionId?: string | null,
  onProgress?: (line: string) => void,
  channelPrompt?: string,
  abortController?: AbortController,
  onQueryCreated?: (q: { close(): void }) => void,
  disallowedTools?: string[],
): Promise<ClaudeResult> {
  return invokeAgent({
    prompt: sessionId ? text : `${topicPrefix("Direct", text)} ${text}`,
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: `${channelPrompt ? channelPrompt + "\n\n" : ""}You are running inside a Telegram bot. Do NOT use AskUserQuestion — it is unavailable. If you need clarification, make your best judgment and proceed.

Formatting rules (Telegram has limited formatting support):
- Bold (**text**), italic (*text*), strikethrough (~~text~~), inline code (\`code\`), code blocks (\`\`\`), blockquotes (>), and [links](url) all work.
- Do NOT use markdown headers (#, ##, etc.) — they have no Telegram equivalent. Instead just use **bold text** on its own line as a section label.
- Do NOT use markdown tables — they render as broken text. Use lists instead.
- Numbered lists (1. 2. 3.) work as plain text. Bullet markers (- or *) are converted to • characters.
- Keep formatting minimal and clean. Prefer plain text with selective bold for emphasis over heavily formatted responses.

Context retrieval:
- Relevant KB context has already been retrieved and included in the message under [Retrieved KB context]. Use this context to ground your response.
- Do NOT search the KB again unless you specifically need something that wasn't covered by the pre-loaded context.`,
    },
    settingSources: ["project", "local"],
    allowedTools: ALLOWED_TOOLS,
    ...(disallowedTools?.length ? { disallowedTools } : {}),
    maxTurns: 50,
    resume: sessionId ?? undefined,
    abortController,
    onQueryCreated,
    onProgress,
  });
}
