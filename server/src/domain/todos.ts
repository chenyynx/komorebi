/**
 * Todos projection — extracts the agent's task state from canonical
 * `assistant/message` events (live) and transcript replay items (restart
 * fallback). Client contract: GatewayTask {content, status} (GatewayDtos.kt:125,
 * Swift GatewayModels.swift "WebUI 的 todo_write 投影；移动端仅展示").
 *
 * Two tool families feed one projection (both observed live on this host,
 * 2026-09-11, CC 2.1.267 + deepseek stack):
 *  1. TodoWrite {todos:[{content,status}]} — the classic list API; the last
 *     write wins. This is also the only family the official gateway projects
 *     (lib/index.mjs:2835 key 'todos').
 *  2. TaskCreate {subject,activeForm?,description} / TaskUpdate {taskId,
 *     subject?,status?} — the newer per-task API; state is rebuilt by folding
 *     the ordered call sequence (ids come from tool_result previews, so we key
 *     by callId — create-then-update pairs share the task via order, and a
 *     missing id degrades gracefully).
 * `todos: null` means "never written" and the client hides the task card
 * (PROTOCOL.md:786); an empty array means "written and cleared".
 * @module domain/todos
 */

/** Client shape: GatewayTask {content: String, status: String}. */
export interface TodoItem {
  readonly content: string;
  readonly status: "pending" | "in_progress" | "completed";
}

/** Canonical event / transcript replay toolCalls entry shape (both produce it). */
export interface TodoToolCall {
  readonly callId?: string;
  readonly name?: string;
  readonly arguments?: string;
}

const STATUSES = new Set(["pending", "in_progress", "completed"]);

function parseArguments(call: TodoToolCall): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(call.arguments ?? "");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function validTodoItem(raw: unknown): TodoItem | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const item = raw as { content?: unknown; status?: unknown };
  if (typeof item.content !== "string" || item.content === "") return undefined;
  if (typeof item.status !== "string" || !STATUSES.has(item.status)) return undefined;
  return { content: item.content, status: item.status as TodoItem["status"] };
}

/** Latest TodoWrite list; undefined = no valid write seen. */
export function todosFromToolCalls(calls: readonly TodoToolCall[]): readonly TodoItem[] | undefined {
  let latest: readonly TodoItem[] | undefined = undefined;
  for (const call of calls) {
    if (call.name !== "TodoWrite") continue;
    const input = parseArguments(call);
    const todos = input?.todos;
    if (!Array.isArray(todos)) continue; // torn write: keep the previous valid list
    const items: TodoItem[] = [];
    let ok = true;
    for (const raw of todos) {
      const item = validTodoItem(raw);
      if (item === undefined) { ok = false; break; }
      items.push(item);
    }
    if (ok) latest = items;
  }
  return latest;
}

/** Convenience: scan one canonical event's toolCalls array. */
export function todosFromEventToolCalls(toolCalls: readonly TodoToolCall[] | undefined): readonly TodoItem[] | undefined {
  if (toolCalls === undefined) return undefined;
  return todosFromToolCalls(toolCalls);
}

/**
 * Stateful fold for the TaskCreate/TaskUpdate family. Updates are separate
 * tool_use calls whose callId shares nothing with the create callId — the
 * linkage lives in the tool_result preview ("Task #1 created successfully"),
 * which canonical events never carry. Live data (2026-09-11, CC 2.1.267):
 * TaskUpdate input carries the human-facing `taskId` ("1","2",…), which
 * matches the Nth TaskCreate of the session in order. The folder therefore
 * keys created tasks by creation ordinal and resolves updates through it.
 */
export class TaskFolder {
  private order: number[] = [];
  private items = new Map<number, TodoItem>();
  private nextOrdinal = 1;

  /** Fold one event's toolCalls (in wire order); returns the current list. */
  fold(toolCalls: readonly TodoToolCall[]): readonly TodoItem[] {
    for (const call of toolCalls) {
      const input = parseArguments(call);
      if (input === undefined) continue; // torn write: skip, never crash
      if (call.name === "TaskCreate") {
        const content = typeof input["activeForm"] === "string" && input["activeForm"] !== ""
          ? input["activeForm"]
          : typeof input["subject"] === "string" ? input["subject"] : undefined;
        if (content === undefined) continue;
        this.items.set(this.nextOrdinal, { content, status: "pending" });
        this.order.push(this.nextOrdinal);
        this.nextOrdinal++;
      } else if (call.name === "TaskUpdate") {
        const raw = input["taskId"];
        const ordinal = typeof raw === "string" ? Number.parseInt(raw, 10) : typeof raw === "number" ? raw : NaN;
        if (!Number.isSafeInteger(ordinal)) continue;
        const item = this.items.get(ordinal);
        if (item === undefined) continue; // unknown id (e.g. created pre-restart): ignore
        const status = input["status"];
        if (status === "deleted") {
          this.items.delete(ordinal);
          const idx = this.order.indexOf(ordinal);
          if (idx >= 0) this.order.splice(idx, 1);
          continue;
        }
        if (status !== "in_progress" && status !== "completed") continue; // content-only update
        this.items.set(ordinal, { content: item.content, status });
      }
    }
    return this.list();
  }

  /** Current projection (empty array = all tasks done/deleted; client shows an empty card). */
  list(): readonly TodoItem[] {
    return this.order.map((id) => this.items.get(id)!).filter((t): t is TodoItem => t !== undefined);
  }
}

/**
 * The single entry the orchestrator uses per event: TodoWrite (stateless, the
 * full list rides every call) wins whenever present; otherwise undefined and
 * the caller folds Task* calls into the session's TaskFolder instead.
 */
export function todosFromAnyToolCalls(toolCalls: readonly TodoToolCall[] | undefined): readonly TodoItem[] | undefined {
  if (toolCalls === undefined) return undefined;
  return todosFromToolCalls(toolCalls);
}
