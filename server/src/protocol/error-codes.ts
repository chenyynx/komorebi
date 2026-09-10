/**
 * Error codes and messages — must match PROTOCOL.md §1 uniform error frame.
 * @module protocol/error-codes
 */

export const ERROR_CODES = {
  BAD_REQUEST: "bad-request",
  SESSION_NOT_FOUND: "session-not-found",
  AGENT_BUSY: "agent-busy",
  MODEL_UNAVAILABLE: "model-unavailable",
  FORK_UNAVAILABLE: "fork-unavailable",
  UNKNOWN_COMMAND: "unknown-command",
  WORKSPACE_INVALID_PATH: "workspace-invalid-path",
  DIRECTORY_UNREADABLE: "directory-unreadable",
  DIRECTORY_EXISTS: "directory-exists",
  WRONG_CHANNEL: "wrong-channel",
  INTERNAL: "internal",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** Human-readable message per code; `%s` placeholders filled by call sites. */
export const ERROR_MESSAGES: Readonly<Record<ErrorCode, string>> = {
  [ERROR_CODES.BAD_REQUEST]: "malformed request: %s",
  [ERROR_CODES.SESSION_NOT_FOUND]: "no such session: %s",
  [ERROR_CODES.AGENT_BUSY]: "session %s already has a running turn",
  [ERROR_CODES.MODEL_UNAVAILABLE]: "no adapter serves provider %s; select a model for this session",
  [ERROR_CODES.FORK_UNAVAILABLE]: "cannot fork a session with a turn in progress",
  [ERROR_CODES.UNKNOWN_COMMAND]: "unknown command: %s",
  [ERROR_CODES.WORKSPACE_INVALID_PATH]: "workspace path rejected: %s",
  [ERROR_CODES.DIRECTORY_UNREADABLE]: "cannot read directory: %s",
  [ERROR_CODES.DIRECTORY_EXISTS]: "directory already exists: %s",
  [ERROR_CODES.WRONG_CHANNEL]: "request %s must be sent on the %s channel",
  [ERROR_CODES.INTERNAL]: "internal error: %s",
};

/** Format an error message with placeholder substitution. */
export function errorMessage(code: ErrorCode, ...args: readonly (string | number)[]): string {
  const template = ERROR_MESSAGES[code];
  let message = template;
  for (const arg of args) {
    message = message.replace("%s", String(arg));
  }
  return message;
}
