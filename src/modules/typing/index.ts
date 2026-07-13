/**
 * Typing indicator refresh — default module.
 *
 * Most platforms expire a typing indicator after 5–10s, so a one-shot
 * call on message arrival goes stale long before the agent finishes
 * thinking. This module keeps it alive by re-firing `setTyping` on a
 * short interval — but only while the agent is actually WORKING, gated
 * on the heartbeat file's mtime after an initial grace period.
 *
 * A terminal user-facing response stops the refresher and explicitly clears
 * the platform typing state.
 *
 * Default module status:
 *   - Lives in src/modules/ for signaling (not really core), but ships
 *     on main and is imported directly by core. No registry, no hook.
 *   - Removing requires editing src/router.ts, src/delivery.ts, and
 *     src/container-runner.ts to drop the calls.
 */
import fs from 'fs';

import { log } from '../../log.js';
import { heartbeatPath } from '../../session-manager.js';

const TYPING_REFRESH_MS = 4000;
/**
 * Grace window from startTypingRefresh: fire typing unconditionally
 * for this long regardless of heartbeat state. Covers container
 * spawn/wake latency (5–12s on cold start before first heartbeat).
 */
const TYPING_GRACE_MS = 15000;
/**
 * After the grace window, a heartbeat must be mtimed within this
 * many ms of now to count as "agent is working." Heartbeats land
 * every few hundred ms during active work, so 6s is well above
 * the working floor and small enough to stop typing quickly when
 * the agent goes idle.
 */
const HEARTBEAT_FRESH_MS = 6000;
interface TypingAdapter {
  setTyping?(
    channelType: string,
    platformId: string,
    threadId: string | null,
    instance?: string,
    agentGroupId?: string,
  ): Promise<void>;
  clearTyping?(
    channelType: string,
    platformId: string,
    threadId: string | null,
    instance?: string,
    agentGroupId?: string,
  ): Promise<void>;
}

interface TypingTarget {
  agentGroupId: string;
  channelType: string;
  platformId: string;
  threadId: string | null;
  /** Adapter instance that owns the chat; undefined = default (= channelType). */
  instance?: string;
  interval: NodeJS.Timeout;
  startedAt: number;
}

let adapter: TypingAdapter | null = null;
const typingRefreshers = new Map<string, TypingTarget>();

/**
 * Bind the typing module to the channel delivery adapter so it can
 * call `setTyping`. Called once by `src/delivery.ts` inside
 * `setDeliveryAdapter`. Passing a fresh adapter replaces the prior
 * binding and leaves active refreshers in place (they'll use the
 * new adapter on their next tick).
 */
export function setTypingAdapter(a: TypingAdapter): void {
  adapter = a;
}

async function setTypingState(
  state: 'active' | 'cleared',
  channelType: string,
  platformId: string,
  threadId: string | null,
  instance?: string,
  agentGroupId?: string,
): Promise<void> {
  try {
    const method = state === 'active' ? adapter?.setTyping : adapter?.clearTyping;
    await method?.(channelType, platformId, threadId, instance, agentGroupId);
    // eslint-disable-next-line no-catch-all/no-catch-all -- typing is best-effort; must not block routing
  } catch (err) {
    log.debug('Typing state update failed (best-effort)', { state, channelType, platformId, threadId, err });
  }
}

function isHeartbeatFresh(agentGroupId: string, sessionId: string): boolean {
  const hbPath = heartbeatPath(agentGroupId, sessionId);
  try {
    const stat = fs.statSync(hbPath);
    return Date.now() - stat.mtimeMs < HEARTBEAT_FRESH_MS;
  } catch {
    return false;
  }
}

export function startTypingRefresh(
  sessionId: string,
  agentGroupId: string,
  channelType: string,
  platformId: string,
  threadId: string | null,
  instance?: string,
): void {
  const existing = typingRefreshers.get(sessionId);
  if (existing) {
    // Already refreshing. Fire an immediate tick for the new inbound
    // event and reset the grace window — the new message restarts
    // the container-wake latency budget. Also clear any lingering
    // terminal state: a new inbound means the user expects typing to show
    // immediately.
    void setTypingState('active', channelType, platformId, threadId, instance, agentGroupId);
    existing.startedAt = Date.now();
    // Keep the stored entry self-consistent: a re-trigger can arrive from
    // a different chat address (agent-shared sessions span messaging
    // groups, possibly on different platforms/instances), so the address
    // fields and the owning instance must move together — a torn entry
    // (old address + new instance) would hand e.g. a telegram platformId
    // to a Slack instance's setTyping on the next interval tick.
    existing.channelType = channelType;
    existing.platformId = platformId;
    existing.threadId = threadId;
    existing.instance = instance;
    existing.agentGroupId = agentGroupId;
    return;
  }

  // Immediate tick + periodic refresh.
  void setTypingState('active', channelType, platformId, threadId, instance, agentGroupId);
  const startedAt = Date.now();
  const interval = setInterval(() => {
    const entry = typingRefreshers.get(sessionId);
    if (!entry) return; // stopped externally since this tick was scheduled

    const withinGrace = Date.now() - entry.startedAt < TYPING_GRACE_MS;
    if (withinGrace || isHeartbeatFresh(entry.agentGroupId, sessionId)) {
      void setTypingState(
        'active',
        entry.channelType,
        entry.platformId,
        entry.threadId,
        entry.instance,
        entry.agentGroupId,
      );
      return;
    }

    // Out of grace AND heartbeat stale — agent is idle, stop refreshing.
    // Clear before forgetting the target. Otherwise a provider failure or a
    // long silent generation can leave clients displaying "composing"
    // forever, and a later terminal response has no target left to clear.
    void setTypingState(
      'cleared',
      entry.channelType,
      entry.platformId,
      entry.threadId,
      entry.instance,
      entry.agentGroupId,
    );
    clearInterval(entry.interval);
    typingRefreshers.delete(sessionId);
  }, TYPING_REFRESH_MS);
  // unref so a stale refresher can't hold the event loop alive.
  interval.unref();
  typingRefreshers.set(sessionId, {
    agentGroupId,
    channelType,
    platformId,
    threadId,
    instance,
    interval,
    startedAt,
  });
}

export function stopTypingRefresh(sessionId: string): void {
  const entry = typingRefreshers.get(sessionId);
  if (!entry) return;
  void setTypingState(
    'cleared',
    entry.channelType,
    entry.platformId,
    entry.threadId,
    entry.instance,
    entry.agentGroupId,
  );
  clearInterval(entry.interval);
  typingRefreshers.delete(sessionId);
}
