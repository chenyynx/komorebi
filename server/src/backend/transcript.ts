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
    /**
     * API message id. Present on 620/620 assistant lines across the last 12
     * real transcripts on this host (2026-09-10) and stable across the block
     * split, which is what makes per-message merging possible.
     */
    readonly id?: string;
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

/**
 * Blocks of one assistant API message, merged into a single replay canonical.
 * Deliberately mirrors the live translator's PendingCanonical so both channels
 * hand the client the SAME event structure for the same round trip.
 */
interface OpenMessage {
  readonly id: string;
  /** Step owned by this message (a tool_use inside it must not move it). */
  readonly step: number;
  time: number;
  text: string;
  reasoning: string;
  toolCalls: { callId: string; name: string; arguments: string }[];
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
    /**
     * CC stores ONE LINE PER COMPLETED CONTENT BLOCK, all sharing a single API
     * message id (measured: [thinking] then [tool_use] then [text]). Emitting a
     * canonical per line would hand the client a different shape than the live
     * stream does — and a canonical freezes its turn-step key on the client,
     * which is exactly what killed live streaming. So replay merges by id and
     * emits ONE canonical per API message, with the message's own step.
     */
    let open: OpenMessage | undefined;
    /** Disambiguates id-less lines so a missing id can never cause a wrong merge. */
    let noIdSeq = 0;
    const flushOpen = (): void => {
      const m = open;
      if (m === undefined) return;
      open = undefined;
      // content-free assembly: nothing renderable, so no canonical (an empty
      // one would freeze a key for nothing — same guard as the translator)
      if (m.text === "" && m.reasoning === "" && m.toolCalls.length === 0) return;
      items.push({
        type: "assistant/message",
        time: m.time,
        data: { turn, step: m.step, text: m.text, reasoning: m.reasoning, toolCalls: m.toolCalls },
      });
    };
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
          // the assistant message that produced these results is over; settle it
          // first so the canonical precedes its tool/result (live wire order)
          flushOpen();
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
          // no id on a line → never merge (uniqueness has to be proven, not assumed)
          const id = entry.message?.id ?? `noid-${++noIdSeq}`;
          if (open !== undefined && open.id !== id) flushOpen();
          let slot = open;
          if (slot === undefined) {
            slot = { id, step, time, text: "", reasoning: "", toolCalls: [] };
            open = slot;
          } else {
            slot.time = time; // canonical lands at the message's last block (live: message_stop)
          }
          for (const block of content) {
            if (block.type === "text") slot.text += block.text ?? "";
            else if (block.type === "thinking") slot.reasoning += block.thinking ?? "";
            else if (block.type === "tool_use") {
              slot.toolCalls.push({
                callId: block.id ?? `tool-${turn}-${step}`,
                name: block.name ?? "tool",
                arguments: JSON.stringify(block.input ?? {}),
              });
              step++;
            }
          }
          break;
        }
        default:
          // queue-operation / attachment / last-prompt / custom-title / … → ignore
          break;
      }
    }
    flushOpen(); // trailing message without a following line (last turn of the session)
    return items;
  }
}

function normalizeContent(content: readonly SdkBlockLike[] | string | undefined): readonly SdkBlockLike[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (Array.isArray(content)) return content;
  return [];
}
