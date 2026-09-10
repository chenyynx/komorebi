/**
 * Inbound frame validation — discriminated by `type`, strict field checks.
 * Every rule derived from PROTOCOL.md v0.7.2 examples, not from memory.
 * @module protocol/validation
 */

import { ERROR_CODES, errorMessage } from "./error-codes.js";

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function optionalNonEmptyString(value: unknown): value is string | undefined {
  return value === undefined || nonEmptyString(value);
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function optionalSafeInt(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === "number" && Number.isSafeInteger(value));
}

/** Base fields shared by most inbound frames. */
export interface InboundBase {
  readonly type: string;
  readonly sessionId?: string;
}

export interface MessageFrame extends InboundBase {
  readonly text?: string | undefined;
  readonly images?: readonly {
    mediaType: string;
    data: string;
    name?: string;
  }[] | undefined;
  readonly mode?: "queue" | "steer";
  readonly workspaceId?: string | undefined;
  readonly cwd?: string | undefined;
  readonly clientTimeZone?: string | undefined;
}

export interface HistoryFrame extends InboundBase {
  readonly beforeSeq?: number | undefined;
  readonly maxMessages?: number | undefined;
  readonly maxBytes?: number | undefined;
  readonly view?: string | undefined;
}

export interface SelectModelFrame extends InboundBase {
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort?: string | undefined;
}

export interface QueueUpdateFrame extends InboundBase {
  readonly itemId: string;
  readonly action: "edit" | "remove" | "steer";
  readonly text?: string | undefined;
}

export interface QuestionAnswerFrame extends InboundBase {
  readonly rpcId: string;
  readonly answers: readonly {
    id: string;
    selected?: readonly string[];
    custom?: string;
  }[];
}

export interface ApprovalResponseFrame extends InboundBase {
  readonly rpcId: string;
  readonly approvalId: string;
  readonly outcome: "allowed-once" | "rejected";
}

export interface GoalEditFrame extends InboundBase {
  readonly ref: { id: string; revision: number };
  readonly objective?: string | undefined;
  readonly maxGoalRounds?: number | undefined;
}

export type ValidatedFrame =
  | { type: "ping" }
  | { type: "subscribe"; sessionId: string }
  | { type: "unsubscribe" }
  | { type: "sessions" }
  | { type: "search"; query: string }
  | { type: "session-create"; requestId: string; workspaceId?: string; cwd?: string }
  | { type: "session-cancel"; sessionId: string }
  | { type: "session-rename"; sessionId: string; title: string }
  | { type: "session-archive"; sessionId: string }
  | { type: "message"; frame: MessageFrame }
  | { type: "history"; frame: HistoryFrame }
  | { type: "attachment"; sessionId: string; attachmentId: string }
  | { type: "models"; sessionId?: string }
  | { type: "providers" }
  | { type: "select-model"; frame: SelectModelFrame }
  | { type: "default-model" }
  | { type: "save-default-model"; provider: string; model: string; reasoningEffort?: string }
  | { type: "permission-options"; sessionId?: string }
  | { type: "permission"; sessionId: string; name: string }
  | { type: "context-usage"; sessionId: string }
  | { type: "session-stats"; sessionId: string }
  | { type: "tasks"; sessionId: string }
  | { type: "goal"; sessionId: string }
  | { type: "goal-edit"; frame: GoalEditFrame }
  | { type: "goal-pause"; sessionId: string; ref: { id: string; revision: number } }
  | { type: "goal-resume"; sessionId: string; ref: { id: string; revision: number } }
  | { type: "goal-clear"; sessionId: string; ref: { id: string; revision: number } }
  | { type: "workspaces" }
  | { type: "workspace-create"; path: string }
  | { type: "directories"; path?: string }
  | { type: "directory-create"; path: string; name: string }
  | { type: "host" }
  | { type: "agent-presets" }
  | { type: "defaults" }
  | { type: "set-default"; target: string; value: string }
  | { type: "commands"; sessionId: string; locale?: string }
  | { type: "command-execute"; sessionId: string; line: string }
  | { type: "command-options"; sessionId: string; command: string }
  | { type: "command-select"; sessionId: string; command: string; optionId: string }
  | { type: "fork"; sessionId: string; atSeq?: number }
  | { type: "queue-update"; frame: QueueUpdateFrame }
  | { type: "question-answer"; frame: QuestionAnswerFrame }
  | { type: "question-cancel"; rpcId: string; sessionId?: string }
  | { type: "approval-response"; frame: ApprovalResponseFrame }
  | { type: "file-list"; sessionId: string; path?: string; requestId?: string }
  | { type: "file-download-open"; sessionId: string; path: string; requestId: string }
  | { type: "file-download-read"; transferId: string; offset: number }
  | { type: "file-download-cancel"; transferId: string };

function fail(code: string, message: string): { ok: false; code: string; message: string } {
  return { ok: false, code, message };
}

function requireSessionId(raw: Record<string, unknown>): ValidationResult<string> {
  const value = raw["sessionId"];
  if (!nonEmptyString(value)) {
    return fail(ERROR_CODES.BAD_REQUEST, errorMessage(ERROR_CODES.BAD_REQUEST, "sessionId must be a non-empty string"));
  }
  return { ok: true, value };
}

function refField(raw: Record<string, unknown>): ValidationResult<{ id: string; revision: number }> {
  const ref = raw["ref"];
  if (!isRecord(ref) || !nonEmptyString(ref["id"]) || typeof ref["revision"] !== "number" || !Number.isSafeInteger(ref["revision"])) {
    return fail(ERROR_CODES.BAD_REQUEST, errorMessage(ERROR_CODES.BAD_REQUEST, "ref must be {id: string, revision: int}"));
  }
  return { ok: true, value: { id: ref["id"] as string, revision: ref["revision"] as number } };
}

/** Main entry: parse one inbound JSON frame. Unknown types are rejected, not ignored. */
export function validateInbound(raw: unknown): ValidationResult<ValidatedFrame> {
  if (!isRecord(raw)) {
    return fail(ERROR_CODES.BAD_REQUEST, errorMessage(ERROR_CODES.BAD_REQUEST, "frame must be a JSON object"));
  }
  const type = raw["type"];
  if (!nonEmptyString(type)) {
    return fail(ERROR_CODES.BAD_REQUEST, errorMessage(ERROR_CODES.BAD_REQUEST, "missing type"));
  }
  switch (type) {
    case "ping":
    case "unsubscribe":
    case "sessions":
    case "providers":
    case "workspaces":
    case "host":
    case "agent-presets":
    case "defaults":
    case "default-model":
      return { ok: true, value: { type } as ValidatedFrame };
    case "subscribe":
    case "session-cancel":
    case "attachment":
    case "context-usage":
    case "session-stats":
    case "tasks":
    case "goal":
    case "commands":
    case "command-execute":
    case "command-options":
    case "fork":
    case "file-list": {
      const sessionId = requireSessionId(raw);
      if (!sessionId.ok) return sessionId;
      if (type === "subscribe") return { ok: true, value: { type, sessionId: sessionId.value } };
      if (type === "session-cancel") return { ok: true, value: { type, sessionId: sessionId.value } };
      if (type === "context-usage" || type === "session-stats" || type === "tasks" || type === "goal") {
        return { ok: true, value: { type, sessionId: sessionId.value } };
      }
      if (type === "commands") {
        const locale = optionalString(raw["locale"]) ? (raw["locale"] as string | undefined) : undefined;
        return locale === undefined
          ? { ok: true, value: { type, sessionId: sessionId.value } }
          : { ok: true, value: { type, sessionId: sessionId.value, locale } };
      }
      if (type === "attachment") {
        const attachmentId = raw["attachmentId"];
        if (!nonEmptyString(attachmentId)) {
          return fail(ERROR_CODES.BAD_REQUEST, errorMessage(ERROR_CODES.BAD_REQUEST, "attachmentId required"));
        }
        return { ok: true, value: { type, sessionId: sessionId.value, attachmentId } };
      }
      if (type === "command-execute") {
        const line = raw["line"];
        if (!nonEmptyString(line) || !line.startsWith("/")) {
          return fail(ERROR_CODES.BAD_REQUEST, errorMessage(ERROR_CODES.BAD_REQUEST, "line must start with /"));
        }
        return { ok: true, value: { type, sessionId: sessionId.value, line } };
      }
      if (type === "command-options") {
        const command = raw["command"];
        if (!nonEmptyString(command)) {
          return fail(ERROR_CODES.BAD_REQUEST, errorMessage(ERROR_CODES.BAD_REQUEST, "command required"));
        }
        return { ok: true, value: { type, sessionId: sessionId.value, command } };
      }
      if (type === "fork") {
        const atSeq = optionalSafeInt(raw["atSeq"]) ? (raw["atSeq"] as number | undefined) : undefined;
        return atSeq === undefined
          ? { ok: true, value: { type, sessionId: sessionId.value } }
          : { ok: true, value: { type, sessionId: sessionId.value, atSeq } };
      }
      // file-list
      const path = optionalString(raw["path"]) ? (raw["path"] as string | undefined) : undefined;
      const requestId = optionalString(raw["requestId"]) ? (raw["requestId"] as string | undefined) : undefined;
      const base = { type: type as "file-list", sessionId: sessionId.value };
      return { ok: true, value: path === undefined ? (requestId === undefined ? base : { ...base, requestId }) : (requestId === undefined ? { ...base, path } : { ...base, path, requestId }) };
    }
    case "search": {
      const query = raw["query"];
      if (typeof query !== "string") {
        return fail(ERROR_CODES.BAD_REQUEST, errorMessage(ERROR_CODES.BAD_REQUEST, "query required"));
      }
      return { ok: true, value: { type, query } };
    }
    case "session-create": {
      const requestId = raw["requestId"];
      if (!nonEmptyString(requestId)) {
        return fail(ERROR_CODES.BAD_REQUEST, errorMessage(ERROR_CODES.BAD_REQUEST, "requestId required"));
      }
      const workspaceId = optionalNonEmptyString(raw["workspaceId"]) ? (raw["workspaceId"] as string | undefined) : undefined;
      const cwd = optionalNonEmptyString(raw["cwd"]) ? (raw["cwd"] as string | undefined) : undefined;
      const base = { type: type as "session-create", requestId };
      return { ok: true, value: cwd === undefined ? (workspaceId === undefined ? base : { ...base, workspaceId }) : (workspaceId === undefined ? { ...base, cwd } : { ...base, workspaceId, cwd }) };
    }
    case "session-rename": {
      const sessionId = requireSessionId(raw);
      if (!sessionId.ok) return sessionId;
      const title = raw["title"];
      if (!nonEmptyString(title)) {
        return fail(ERROR_CODES.BAD_REQUEST, errorMessage(ERROR_CODES.BAD_REQUEST, "title required"));
      }
      return { ok: true, value: { type, sessionId: sessionId.value, title } };
    }
    case "session-archive": {
      const sessionId = requireSessionId(raw);
      if (!sessionId.ok) return sessionId;
      return { ok: true, value: { type, sessionId: sessionId.value } };
    }
    case "message": {
      const text = raw["text"];
      const images = raw["images"];
      const hasText = typeof text === "string" && text.length > 0;
      const hasImages = Array.isArray(images) && images.length > 0;
      if (!hasText && !hasImages) {
        return fail(ERROR_CODES.BAD_REQUEST, errorMessage(ERROR_CODES.BAD_REQUEST, "text or images required"));
      }
      const sessionId = optionalNonEmptyString(raw["sessionId"]) ? (raw["sessionId"] as string | undefined) : undefined;
      const mode: "queue" | "steer" = raw["mode"] === "steer" ? "steer" : "queue";
      const workspaceId = optionalNonEmptyString(raw["workspaceId"]) ? (raw["workspaceId"] as string | undefined) : undefined;
      const cwd = optionalNonEmptyString(raw["cwd"]) ? (raw["cwd"] as string | undefined) : undefined;
      const clientTimeZone = optionalString(raw["clientTimeZone"]) ? (raw["clientTimeZone"] as string | undefined) : undefined;
      const frame: MessageFrame = {
        type: "message",
        mode,
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(hasText ? { text: text as string } : {}),
        ...(hasImages ? { images: images as MessageFrame["images"] } : {}),
        ...(workspaceId !== undefined ? { workspaceId } : {}),
        ...(cwd !== undefined ? { cwd } : {}),
        ...(clientTimeZone !== undefined ? { clientTimeZone } : {}),
      };
      return { ok: true, value: { type, frame } };
    }
    case "history": {
      const sessionId = requireSessionId(raw);
      if (!sessionId.ok) return sessionId;
      if (raw["beforeSeq"] !== undefined && !(typeof raw["beforeSeq"] === "number" && Number.isSafeInteger(raw["beforeSeq"]))) {
        return fail(ERROR_CODES.BAD_REQUEST, errorMessage(ERROR_CODES.BAD_REQUEST, "beforeSeq must be an integer"));
      }
      const beforeSeq = raw["beforeSeq"] === undefined ? undefined : (raw["beforeSeq"] as number);
      const maxMessages = optionalSafeInt(raw["maxMessages"]) ? (raw["maxMessages"] as number | undefined) : undefined;
      const maxBytes = optionalSafeInt(raw["maxBytes"]) ? (raw["maxBytes"] as number | undefined) : undefined;
      const view = optionalString(raw["view"]) ? (raw["view"] as string | undefined) : undefined;
      const frame: HistoryFrame = {
        type: "history",
        sessionId: sessionId.value,
        ...(beforeSeq !== undefined ? { beforeSeq } : {}),
        ...(maxMessages !== undefined ? { maxMessages } : {}),
        ...(maxBytes !== undefined ? { maxBytes } : {}),
        ...(view !== undefined ? { view } : {}),
      };
      return { ok: true, value: { type, frame } };
    }
    case "models": {
      const sessionId = optionalNonEmptyString(raw["sessionId"]) ? (raw["sessionId"] as string | undefined) : undefined;
      return sessionId === undefined
        ? { ok: true, value: { type: "models" } }
        : { ok: true, value: { type: "models", sessionId } };
    }
    case "select-model": {
      const sessionId = requireSessionId(raw);
      if (!sessionId.ok) return sessionId;
      const provider = raw["provider"];
      const model = raw["model"];
      if (!nonEmptyString(provider) || !nonEmptyString(model)) {
        return fail(ERROR_CODES.BAD_REQUEST, errorMessage(ERROR_CODES.BAD_REQUEST, "provider and model required"));
      }
      const reasoningEffort = optionalNonEmptyString(raw["reasoningEffort"]) ? (raw["reasoningEffort"] as string | undefined) : undefined;
      return { ok: true, value: { type, frame: { type, sessionId: sessionId.value, provider, model, ...(reasoningEffort !== undefined ? { reasoningEffort } : {}) } } };
    }
    case "save-default-model": {
      const provider = raw["provider"];
      const model = raw["model"];
      if (!nonEmptyString(provider) || !nonEmptyString(model)) {
        return fail(ERROR_CODES.BAD_REQUEST, errorMessage(ERROR_CODES.BAD_REQUEST, "provider and model required"));
      }
      const reasoningEffort = optionalNonEmptyString(raw["reasoningEffort"]) ? (raw["reasoningEffort"] as string | undefined) : undefined;
      return { ok: true, value: { type, provider, model, ...(reasoningEffort !== undefined ? { reasoningEffort } : {}) } };
    }
    case "permission-options": {
      const sessionId = optionalNonEmptyString(raw["sessionId"]) ? (raw["sessionId"] as string | undefined) : undefined;
      return sessionId === undefined
        ? { ok: true, value: { type: "permission-options" } }
        : { ok: true, value: { type: "permission-options", sessionId } };
    }
    case "permission": {
      const sessionId = requireSessionId(raw);
      if (!sessionId.ok) return sessionId;
      const name = raw["name"];
      if (!nonEmptyString(name)) {
        return fail(ERROR_CODES.BAD_REQUEST, errorMessage(ERROR_CODES.BAD_REQUEST, "name required"));
      }
      return { ok: true, value: { type, sessionId: sessionId.value, name } };
    }
    case "goal-edit": {
      const sessionId = requireSessionId(raw);
      if (!sessionId.ok) return sessionId;
      const ref = refField(raw);
      if (!ref.ok) return ref;
      const objective = optionalNonEmptyString(raw["objective"]) ? (raw["objective"] as string | undefined) : undefined;
      const maxGoalRounds = optionalSafeInt(raw["maxGoalRounds"]) ? (raw["maxGoalRounds"] as number | undefined) : undefined;
      if (objective === undefined && maxGoalRounds === undefined) {
        return fail(ERROR_CODES.BAD_REQUEST, errorMessage(ERROR_CODES.BAD_REQUEST, "objective or maxGoalRounds required"));
      }
      return { ok: true, value: { type, frame: { type, sessionId: sessionId.value, ref: ref.value, ...(objective !== undefined ? { objective } : {}), ...(maxGoalRounds !== undefined ? { maxGoalRounds } : {}) } } };
    }
    case "goal-pause":
    case "goal-resume":
    case "goal-clear": {
      const sessionId = requireSessionId(raw);
      if (!sessionId.ok) return sessionId;
      const ref = refField(raw);
      if (!ref.ok) return ref;
      return { ok: true, value: { type, sessionId: sessionId.value, ref: ref.value } };
    }
    case "workspace-create": {
      const path = raw["path"];
      if (!nonEmptyString(path)) {
        return fail(ERROR_CODES.BAD_REQUEST, errorMessage(ERROR_CODES.BAD_REQUEST, "path required"));
      }
      return { ok: true, value: { type, path } };
    }
    case "directories": {
      const path = optionalString(raw["path"]) ? (raw["path"] as string | undefined) : undefined;
      return path === undefined
        ? { ok: true, value: { type: "directories" } }
        : { ok: true, value: { type: "directories", path } };
    }
    case "directory-create": {
      const path = raw["path"];
      const name = raw["name"];
      if (!nonEmptyString(path) || !nonEmptyString(name) || name === "." || name === ".." || name.includes("/")) {
        return fail(ERROR_CODES.BAD_REQUEST, errorMessage(ERROR_CODES.BAD_REQUEST, "valid path and name required"));
      }
      return { ok: true, value: { type, path, name } };
    }
    case "set-default": {
      const target = raw["target"];
      const value = raw["value"];
      if (!nonEmptyString(target) || !nonEmptyString(value)) {
        return fail(ERROR_CODES.BAD_REQUEST, errorMessage(ERROR_CODES.BAD_REQUEST, "target and value required"));
      }
      return { ok: true, value: { type, target, value } };
    }
    case "command-select": {
      const sessionId = requireSessionId(raw);
      if (!sessionId.ok) return sessionId;
      const command = raw["command"];
      const optionId = raw["optionId"];
      if (!nonEmptyString(command) || !nonEmptyString(optionId)) {
        return fail(ERROR_CODES.BAD_REQUEST, errorMessage(ERROR_CODES.BAD_REQUEST, "command and optionId required"));
      }
      return { ok: true, value: { type, sessionId: sessionId.value, command, optionId } };
    }
    case "queue-update": {
      const sessionId = requireSessionId(raw);
      if (!sessionId.ok) return sessionId;
      const itemId = raw["itemId"];
      const action = raw["action"];
      if (!nonEmptyString(itemId) || (action !== "edit" && action !== "remove" && action !== "steer")) {
        return fail(ERROR_CODES.BAD_REQUEST, errorMessage(ERROR_CODES.BAD_REQUEST, "itemId and valid action required"));
      }
      const text = optionalString(raw["text"]) ? (raw["text"] as string | undefined) : undefined;
      if (action === "edit" && (text === undefined || text.trim() === "")) {
        return fail(ERROR_CODES.BAD_REQUEST, errorMessage(ERROR_CODES.BAD_REQUEST, "edit requires non-empty text"));
      }
      return { ok: true, value: { type, frame: { type, sessionId: sessionId.value, itemId, action, ...(text !== undefined ? { text } : {}) } } };
    }
    case "question-answer": {
      const rpcId = raw["rpcId"];
      if (!nonEmptyString(rpcId)) {
        return fail(ERROR_CODES.BAD_REQUEST, errorMessage(ERROR_CODES.BAD_REQUEST, "rpcId required"));
      }
      const answers = raw["answers"];
      if (!Array.isArray(answers) || answers.length === 0) {
        return fail(ERROR_CODES.BAD_REQUEST, errorMessage(ERROR_CODES.BAD_REQUEST, "answers must be a non-empty array"));
      }
      for (const answer of answers) {
        if (!isRecord(answer) || !nonEmptyString(answer["id"])) {
          return fail(ERROR_CODES.BAD_REQUEST, errorMessage(ERROR_CODES.BAD_REQUEST, "each answer needs id"));
        }
      }
      const sessionId = optionalNonEmptyString(raw["sessionId"]) ? (raw["sessionId"] as string | undefined) : undefined;
      const base = { type: "question-answer" as const, rpcId, answers: answers as QuestionAnswerFrame["answers"] };
      return { ok: true, value: { type, frame: sessionId === undefined ? base : { ...base, sessionId } } };
    }
    case "question-cancel": {
      const rpcId = raw["rpcId"];
      if (!nonEmptyString(rpcId)) {
        return fail(ERROR_CODES.BAD_REQUEST, errorMessage(ERROR_CODES.BAD_REQUEST, "rpcId required"));
      }
      const sessionId = optionalNonEmptyString(raw["sessionId"]) ? (raw["sessionId"] as string | undefined) : undefined;
      return sessionId === undefined
        ? { ok: true, value: { type: "question-cancel", rpcId } }
        : { ok: true, value: { type: "question-cancel", rpcId, sessionId } };
    }
    case "approval-response": {
      const rpcId = raw["rpcId"];
      const approvalId = raw["approvalId"];
      const outcome = raw["outcome"];
      if (!nonEmptyString(rpcId) || !nonEmptyString(approvalId) || (outcome !== "allowed-once" && outcome !== "rejected")) {
        return fail(ERROR_CODES.BAD_REQUEST, errorMessage(ERROR_CODES.BAD_REQUEST, "rpcId, approvalId, outcome (allowed-once|rejected) required"));
      }
      const sessionId = requireSessionId(raw);
      if (!sessionId.ok) return sessionId;
      return { ok: true, value: { type, frame: { type, rpcId, approvalId, outcome, sessionId: sessionId.value } } };
    }
    case "file-download-open": {
      const sessionId = requireSessionId(raw);
      if (!sessionId.ok) return sessionId;
      const path = raw["path"];
      const requestId = raw["requestId"];
      if (!nonEmptyString(path) || !nonEmptyString(requestId)) {
        return fail(ERROR_CODES.BAD_REQUEST, errorMessage(ERROR_CODES.BAD_REQUEST, "path and requestId required"));
      }
      return { ok: true, value: { type, sessionId: sessionId.value, path, requestId } };
    }
    case "file-download-read": {
      const transferId = raw["transferId"];
      const offset = raw["offset"];
      if (!nonEmptyString(transferId) || typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) {
        return fail(ERROR_CODES.BAD_REQUEST, errorMessage(ERROR_CODES.BAD_REQUEST, "transferId and non-negative offset required"));
      }
      return { ok: true, value: { type, transferId, offset } };
    }
    case "file-download-cancel": {
      const transferId = raw["transferId"];
      if (!nonEmptyString(transferId)) {
        return fail(ERROR_CODES.BAD_REQUEST, errorMessage(ERROR_CODES.BAD_REQUEST, "transferId required"));
      }
      return { ok: true, value: { type, transferId } };
    }
    default:
      return fail(ERROR_CODES.UNKNOWN_COMMAND, errorMessage(ERROR_CODES.UNKNOWN_COMMAND, String(type)));
  }
}
