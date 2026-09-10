/**
 * Event broadcaster: fan-out session events to subscribed connections,
 * slow-consumer guard, HITL replay bookkeeping.
 * @module stream/broadcaster
 */

import type { AuthenticatedConnection } from "../ws/server.js";
import type { OutboundFrame } from "../protocol/frames.js";
import { approvalRequestedFrame, eventFrame, questionRequestedFrame } from "../protocol/frames.js";
import type { ClientQuestion } from "../protocol/frames.js";
import { wireEvent } from "../protocol/wire-events.js";
import type { SessionEvent } from "../domain/events.js";

/** Pending approvals per connection for replay on (re)subscribe (protocol §3.2). */
export interface PendingApproval {
  readonly rpcId: string;
  readonly sessionId: string;
  readonly approvalId: string;
  readonly toolName: string;
  readonly callId?: string;
  readonly reason?: string;
}

const SLOW_CONSUMER_MS = 30_000;

interface SendQueueItem {
  readonly text: string;
  readonly enqueuedAt: number;
}

export class EventBroadcaster {
  private subscriptionByConnection = new WeakMap<AuthenticatedConnection, Set<string>>();
  private queues = new Map<AuthenticatedConnection, SendQueueItem[]>();
  private pendingApprovals = new Map<string, PendingApproval>();
  /** Pending questions for replay on (re)subscribe — mirrors the approval set. */
  private pendingQuestions = new Map<string, { rpcId: string; sessionId: string; questions: readonly ClientQuestion[] }>();

  /** Register a connection (called on auth success). */
  track(conn: AuthenticatedConnection): void {
    if (!this.queues.has(conn)) this.queues.set(conn, []);
  }

  /** Drop a connection and its queue (onClose). */
  untrack(conn: AuthenticatedConnection): void {
    this.queues.delete(conn);
    this.subscriptionByConnection.delete(conn);
  }

  /** subscribe filter (protocol §2): after this, only that session's events flow. */
  subscribe(conn: AuthenticatedConnection, sessionId: string): void {
    this.subscriptionByConnection.set(conn, new Set([sessionId]));
  }

  unsubscribe(conn: AuthenticatedConnection): void {
    this.subscriptionByConnection.delete(conn);
  }

  /** Record a pending approval for replay. */
  registerPendingApproval(approval: PendingApproval): void {
    this.pendingApprovals.set(approval.rpcId, approval);
  }

  /** Resolve (and stop replaying) an approval. */
  resolveApproval(rpcId: string): void {
    this.pendingApprovals.delete(rpcId);
  }

  registerPendingQuestion(q: { rpcId: string; sessionId: string; questions: readonly ClientQuestion[] }): void {
    this.pendingQuestions.set(q.rpcId, q);
  }

  resolveQuestion(rpcId: string): void {
    this.pendingQuestions.delete(rpcId);
  }

  /** Replay unresolved questions for a session (official replays questions+approvals on subscribe). */
  replayQuestions(sessionId: string): readonly OutboundFrame[] {
    const frames: OutboundFrame[] = [];
    for (const q of this.pendingQuestions.values()) {
      if (q.sessionId !== sessionId) continue;
      frames.push(questionRequestedFrame({ rpcId: q.rpcId, sessionId: q.sessionId, questions: q.questions, replay: true }));
    }
    return frames;
  }

  /** Replay unresolved approvals for a session (replay: true, protocol §3.2). */
  replayApprovals(sessionId: string): readonly OutboundFrame[] {
    const frames: OutboundFrame[] = [];
    for (const approval of this.pendingApprovals.values()) {
      if (approval.sessionId !== sessionId) continue;
      frames.push(
        approvalRequestedFrame({
          rpcId: approval.rpcId,
          sessionId: approval.sessionId,
          approvalId: approval.approvalId,
          toolName: approval.toolName,
          ...(approval.callId !== undefined ? { callId: approval.callId } : {}),
          ...(approval.reason !== undefined ? { reason: approval.reason } : {}),
          replay: true,
        }),
      );
    }
    return frames;
  }

  /**
   * Fan out one session event to eligible connections.
   * Eligibility: connection tracked, either unfiltered (no subscribe) or subscribed to the session.
   */
  broadcastEvent(sessionId: string, event: SessionEvent, now: number): void {
    const frame = eventFrame(sessionId, event.seq, event.time, wireEvent(event));
    for (const conn of this.queues.keys()) {
      if (!this.eligible(conn, sessionId)) continue;
      this.enqueue(conn, frame, now);
    }
  }

  /** Send a control frame to every tracked connection (e.g. session-title-changed). */
  broadcastControl(frame: OutboundFrame, now: number): void {
    for (const conn of this.queues.keys()) {
      this.enqueue(conn, frame, now);
    }
  }

  /**
   * Interaction frames (question and approval families) go to the CONTROL LANE ONLY —
   * official broadcastInteractionFrame skips mobileChannel==='conversation'
   * (lib/index.mjs:2114). Legacy unsplit connections are lane 'control'.
   */
  broadcastInteraction(frame: OutboundFrame, now: number): void {
    for (const conn of this.queues.keys()) {
      if (conn.lane === "conversation") continue;
      this.enqueue(conn, frame, now);
    }
  }

  /** Send to one connection only. */
  sendTo(conn: AuthenticatedConnection, frame: OutboundFrame, now: number): void {
    this.enqueue(conn, frame, now);
  }

  private eligible(conn: AuthenticatedConnection, sessionId: string): boolean {
    const subscription = this.subscriptionByConnection.get(conn);
    if (subscription === undefined) return true; // unfiltered: receive all sessions
    return subscription.has(sessionId);
  }

  private enqueue(conn: AuthenticatedConnection, frame: OutboundFrame, now: number): void {
    const queue = this.queues.get(conn);
    if (queue === undefined) return;
    queue.push({ text: JSON.stringify(frame), enqueuedAt: now });
    // Slow consumer guard: if the head of the queue sat undrained past the window, drop the connection.
    const head = queue[0];
    if (head !== undefined && now - head.enqueuedAt > SLOW_CONSUMER_MS) {
      conn.ws.close(4004, "slow consumer");
      this.untrack(conn);
      return;
    }
    this.drain(conn);
  }

  private drain(conn: AuthenticatedConnection): void {
    const queue = this.queues.get(conn);
    if (queue === undefined) return;
    while (queue.length > 0) {
      if (conn.ws.readyState !== conn.ws.OPEN) {
        this.untrack(conn);
        return;
      }
      const item = queue.shift();
      if (item === undefined) break;
      conn.ws.send(item.text);
    }
  }
}
