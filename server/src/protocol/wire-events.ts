/**
 * Outbound event wire adapters (protocol §13).
 *
 * Two shapes exist by design, mirroring the upstream dsh-plugin-mobile-gateway:
 *  - live `event` frames -> FLAT refined fields; the KMP client decodes the
 *    payload straight into `GatewayEvent` (there is no `data` wrapper there).
 *  - `history.events[]` -> RAW scheme-A records; the KMP client runs
 *    `RawSessionEvent.normalized()` over them, which reads native block shapes
 *    (`content[]`, `chunk`, `message.content[]`).
 *
 * Getting either shape wrong loses content silently: the client keeps the frame
 * (seq/time are present) but every refined field decodes to null, so user
 * messages and assistant text never render while tool cards still show.
 *
 * @module protocol/wire-events
 */

import type { SessionEvent } from "../domain/events.js";

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json {
  return typeof value === "object" && value !== null ? (value as Json) : {};
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Upstream tool/result preview cap (lib/index.mjs MAX_PREVIEW). */
const MAX_PREVIEW = 400;

/**
 * Live channel: flat refined payload for one event, field names matching the
 * client's `GatewayEvent` exactly (upstream `buildWireEvent`). Two renames are
 * load-bearing: `toolCalls[].callId` -> `id` and `finish.reason` -> `finish.kind`;
 * sending the internal names makes the client's non-null `ToolCall.id` decode
 * fail, which drops the whole frame.
 */
export function wireEvent(event: SessionEvent): Json {
  const d = asRecord(event.data);
  const base: Json = { type: event.type };
  if (d["turn"] !== undefined) base["turn"] = d["turn"];
  if (d["step"] !== undefined) base["step"] = d["step"];

  switch (event.type) {
    case "user/message": {
      const out: Json = { ...base, text: d["text"] ?? "" };
      if (typeof d["source"] === "string") out["source"] = d["source"];
      const images = asArray(d["images"]);
      if (images.length > 0) out["images"] = images; // upstream omits empty
      return out;
    }
    case "assistant/chunk": {
      const chunkType = text(d["chunkType"]);
      const out: Json = { ...base, chunkType };
      if (chunkType === "text-delta" || chunkType === "reasoning-delta") {
        out["text"] = d["text"];
      } else if (chunkType === "tool-call-delta") {
        const tool = asRecord(d["tool"]);
        out["tool"] = {
          id: tool["id"],
          name: tool["name"],
          argumentsDelta: tool["argumentsDelta"],
        };
      } else if (chunkType === "usage") {
        out["usage"] = d["usage"];
      } else if (chunkType === "finish") {
        const finish = asRecord(d["finish"]);
        out["finish"] = { kind: finish["reason"] ?? finish["kind"] };
      }
      return out;
    }
    case "assistant/message": {
      const toolCalls = asArray(d["toolCalls"]).map((call) => {
        const c = asRecord(call);
        return { id: c["callId"] ?? c["id"], name: c["name"], arguments: c["arguments"] };
      });
      const out: Json = {
        ...base,
        text: d["text"] ?? "",
        reasoning: d["reasoning"] ?? "",
        toolCalls,
      };
      if (d["usage"] !== undefined) out["usage"] = d["usage"];
      const images = asArray(d["images"]);
      if (images.length > 0) out["images"] = images;
      return out;
    }
    case "tool/call":
      return { ...base, callId: d["callId"], name: d["name"], arguments: d["arguments"] };
    case "tool/result": {
      const raw = text(d["preview"]) ?? "";
      const preview = raw.length > MAX_PREVIEW ? `${raw.slice(0, MAX_PREVIEW)}…` : raw;
      return { ...base, callId: d["callId"], isError: d["isError"] === true, preview };
    }
    case "session/title": {
      const out: Json = { type: "session/title", title: d["title"] };
      if (d["source"] !== undefined) out["source"] = d["source"];
      return out;
    }
    default: {
      // turn/start|end, step/start|end: position plus an optional reason kind.
      const out: Json = { ...base };
      if (d["reason"] !== undefined) out["reason"] = d["reason"];
      return out;
    }
  }
}

/** History channel: raw scheme-A record consumed by `RawSessionEvent.normalized()`. */
export function schemeAEvent(event: SessionEvent): Json {
  return { type: event.type, seq: event.seq, time: event.time, data: schemeAData(event) };
}

function schemeAData(event: SessionEvent): Json {
  const d = asRecord(event.data);
  const pos: Json = {};
  if (d["turn"] !== undefined) pos["turn"] = d["turn"];
  if (d["step"] !== undefined) pos["step"] = d["step"];

  switch (event.type) {
    case "user/message": {
      const content: Json[] = [];
      const body = text(d["text"]);
      if (body !== undefined && body !== "") content.push({ type: "text", text: body });
      for (const image of asArray(d["images"])) content.push({ type: "image", attachment: image });
      const source = text(d["source"]) ?? "user";
      return { ...pos, content, source: { kind: source } };
    }
    case "assistant/chunk": {
      const chunkType = text(d["chunkType"]);
      const chunk: Json = {};
      if (chunkType !== undefined) chunk["type"] = chunkType;
      if (chunkType === "text-delta" || chunkType === "reasoning-delta") {
        chunk["text"] = d["text"];
      } else if (chunkType === "tool-call-delta") {
        const tool = asRecord(d["tool"]);
        chunk["id"] = tool["id"];
        chunk["name"] = tool["name"];
        chunk["argumentsDelta"] = tool["argumentsDelta"];
      } else if (chunkType === "usage") {
        chunk["usage"] = d["usage"];
      } else if (chunkType === "finish") {
        const finish = asRecord(d["finish"]);
        const kind = text(finish["reason"]) ?? text(finish["kind"]);
        if (kind !== undefined) chunk["reason"] = { kind };
      }
      return { ...pos, chunk };
    }
    case "assistant/message": {
      const blocks: Json[] = [];
      const body = text(d["text"]);
      if (body !== undefined && body !== "") blocks.push({ type: "text", text: body });
      const reasoning = text(d["reasoning"]);
      if (reasoning !== undefined && reasoning !== "") {
        blocks.push({ type: "reasoning", text: reasoning });
      }
      for (const call of asArray(d["toolCalls"])) {
        const c = asRecord(call);
        // internal refined shape uses `callId`; scheme-A blocks expect `id`
        blocks.push({ type: "tool-call", id: c["callId"] ?? c["id"], name: c["name"], arguments: c["arguments"] });
      }
      for (const image of asArray(d["images"])) blocks.push({ type: "image", attachment: image });
      const out: Json = { ...pos, message: { content: blocks } };
      if (d["usage"] !== undefined) out["usage"] = d["usage"];
      return out;
    }
    case "tool/call":
      return { ...pos, callId: d["callId"], name: d["name"], arguments: d["arguments"] };
    case "tool/result": {
      const preview = text(d["preview"]) ?? "";
      const out: Json = {
        ...pos,
        message: {
          source: { callId: d["callId"] },
          content: [{ content: [{ type: "text", text: preview }] }],
        },
      };
      if (d["isError"] === true) out["error"] = { message: "tool error" };
      return out;
    }
    case "turn/start":
    case "turn/end":
    case "step/start":
    case "step/end": {
      const reason = text(d["reason"]);
      return reason !== undefined ? { ...pos, reason: { kind: reason } } : { ...pos };
    }
    case "session/title": {
      const out: Json = { title: d["title"] };
      if (d["source"] !== undefined) out["source"] = d["source"];
      return out;
    }
    default:
      return { ...pos, ...d };
  }
}
