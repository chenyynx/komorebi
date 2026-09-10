/**
 * TranscriptReader — parse Claude Code on-disk transcripts into event drafts.
 * CC writes ~/.claude/projects/<cwd-slug>/<session-uuid>.jsonl with lines:
 * user{message.content:[text|tool_result]}, assistant{message.content:
 * [thinking|text|tool_use]}, plus bookkeeping lines (queue-operation,
 * attachment, last-prompt, file-history-snapshot, custom-title) we ignore.
 * Field shapes extracted from real transcripts on this host 2026-09-10.
 * Replay renumbers seq from 0 in a private seq space (R3: failures degrade to
 * empty history, never crash the session).
 * @module backend/transcript
 */

import type { DraftEvent } from "./translator.js";
import type { SdkBlockLike } from "./translator.js";

/** Transcript line envelope (only documented fields read). */
interface TranscriptLine {
  readonly type?: string;
  readonly message?: {
    readonly role?: string;
    readonly content?: readonly SdkBlockLike[] | string;
  };
  readonly isSidechain?: boolean;
  readonly timestamp?: string;
  readonly session_id?: string;
}

/** Injectable filesystem surface (tests spy without touching disk). */
export interface FileSystem {
  readFile(path: string): string;
  stat(path: string): { mtimeMs: number; size: number };
  exists(path: string): boolean;
}

/** Resolve the transcript path for a CC session id under a project cwd. */
export function transcriptPath(homeDir: string, cwd: string, ccSessionId: string): string {
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  return `${homeDir}/.claude/projects/${slug}/${ccSessionId}.jsonl`;
}

interface CacheEntry {
  readonly mtimeMs: number;
  readonly size: number;
  readonly drafts: readonly ReplayItem[];
}

export interface ReplayItem extends DraftEvent {
  readonly time: number;
}

export class TranscriptReader {
  private cache = new Map<string, CacheEntry>();

  constructor(private readonly fs: FileSystem) {}

  /**
   * Parse a transcript into ordered replay items. Cache keyed by path with
   * mtime+size identity; a second read of an unchanged file performs zero I/O.
   * Any parse failure degrades to an empty list (R3) — the session stays usable.
   */
  read(path: string): readonly ReplayItem[] {
    try {
      if (!this.fs.exists(path)) return [];
      const stat = this.fs.stat(path);
      const cached = this.cache.get(path);
      if (cached !== undefined && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        return cached.drafts;
      }
      const items = this.parse(path);
      this.cache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, drafts: items });
      return items;
    } catch {
      return [];
    }
  }

  private parse(path: string): readonly ReplayItem[] {
    const raw = this.fs.readFile(path);
    const items: ReplayItem[] = [];
    let turn = 0;
    let step = 0;
    let firstTextOfCycle = true;
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue; // malformed line (torn write) → skip, never crash
      }
      const entry = parsed as TranscriptLine;
      if (entry.isSidechain === true) continue; // subagent sidechains are not replayed
      const time = entry.timestamp !== undefined ? Math.floor(Date.parse(entry.timestamp) / 1000) : 0;
      const content = normalizeContent(entry.message?.content);
      switch (entry.type) {
        case "user": {
          // A plain text user line opens a prompt cycle; tool_result lines
          // belong to the current turn and are re-emitted as tool/result.
          const hasText = content.some((b) => b.type === "text" && (b.text ?? "").length > 0);
          if (hasText && !firstTextOfCycle) turn++;
          if (hasText) firstTextOfCycle = false;
          for (const block of content) {
            if (block.type === "text" && (block.text ?? "").length > 0) {
              items.push({ type: "user/message", time, data: { turn, step, text: block.text, source: "user" } });
            } else if (block.type === "tool_result") {
              const output = typeof block.content === "string"
                ? block.content
                : Array.isArray(block.content)
                  ? block.content.map((c: { text?: string }) => c.text ?? "").join("")
                  : "";
              items.push({ type: "tool/result", time, data: { turn, step, callId: block.tool_use_id ?? "unknown", isError: block.is_error === true, preview: output.slice(0, 400) } });
            }
          }
          break;
        }
        case "assistant": {
          let text = "";
          let reasoning = "";
          const toolCalls: { callId: string; name: string; arguments: string }[] = [];
          for (const block of content) {
            if (block.type === "text") text += block.text ?? "";
            else if (block.type === "thinking") reasoning += block.thinking ?? "";
            else if (block.type === "tool_use") {
              toolCalls.push({
                callId: block.id ?? `tool-${turn}-${step}`,
                name: block.name ?? "tool",
                arguments: JSON.stringify(block.input ?? {}),
              });
              step++;
            }
          }
          items.push({ type: "assistant/message", time, data: { turn, step, text, reasoning, toolCalls } });
          break;
        }
        default:
          // queue-operation / attachment / last-prompt / custom-title / … → ignore
          break;
      }
    }
    return items;
  }
}

function normalizeContent(content: readonly SdkBlockLike[] | string | undefined): readonly SdkBlockLike[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (Array.isArray(content)) return content;
  return [];
}
