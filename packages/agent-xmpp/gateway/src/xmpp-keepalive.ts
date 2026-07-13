import type { XmppConnectionState } from './xmpp-component.js';

export interface XmppKeepaliveOptions {
  intervalMs: number;
  failureThreshold: number;
}

export interface XmppKeepaliveCallbacks {
  getState: () => XmppConnectionState;
  getLastActivityAt: () => number;
  ping: () => Promise<void>;
  forceReconnect: (reason: string) => Promise<void>;
  now?: () => number;
}

/** Idle XEP-0199 probe loop. Connection recovery remains owned by the session supervisor. */
export class XmppKeepalive {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private consecutiveFailures = 0;

  constructor(
    private readonly options: XmppKeepaliveOptions,
    private readonly callbacks: XmppKeepaliveCallbacks,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.check(), this.options.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.inFlight = false;
    this.consecutiveFailures = 0;
  }

  private async check(): Promise<void> {
    if (this.inFlight || this.callbacks.getState() !== 'online') return;
    const now = this.callbacks.now?.() ?? Date.now();
    if (now - this.callbacks.getLastActivityAt() < this.options.intervalMs) return;

    this.inFlight = true;
    try {
      await this.callbacks.ping();
      this.consecutiveFailures = 0;
    } catch (error: unknown) {
      this.consecutiveFailures += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[xmpp-gateway] keepalive failed (${this.consecutiveFailures}/${this.options.failureThreshold}): ${message}`,
      );
      if (this.consecutiveFailures >= this.options.failureThreshold) {
        this.consecutiveFailures = 0;
        await this.callbacks.forceReconnect('XEP-0199 keepalive failure threshold reached');
      }
    } finally {
      this.inFlight = false;
    }
  }
}
