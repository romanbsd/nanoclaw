import { afterEach, describe, expect, it, vi } from 'vitest';

import type { XmppConnectionState } from './xmpp-component.js';
import { XmppKeepalive } from './xmpp-keepalive.js';

describe('XmppKeepalive', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('pings only after an online connection has been idle for the interval', async () => {
    vi.useFakeTimers();
    let now = 0;
    let state: XmppConnectionState = 'online';
    let lastActivityAt = 0;
    const ping = vi.fn().mockResolvedValue(undefined);
    const keepalive = new XmppKeepalive(
      { intervalMs: 100, failureThreshold: 2 },
      {
        getState: () => state,
        getLastActivityAt: () => lastActivityAt,
        ping,
        forceReconnect: vi.fn(),
        now: () => now,
      },
    );
    keepalive.start();

    now = 50;
    await vi.advanceTimersByTimeAsync(100);
    expect(ping).not.toHaveBeenCalled();
    lastActivityAt = 50;
    now = 150;
    await vi.advanceTimersByTimeAsync(100);
    expect(ping).toHaveBeenCalledOnce();

    state = 'offline';
    now = 500;
    await vi.advanceTimersByTimeAsync(100);
    expect(ping).toHaveBeenCalledOnce();
    keepalive.stop();
  });

  it('forces one reconnect after the configured consecutive failure threshold', async () => {
    vi.useFakeTimers();
    let now = 100;
    const ping = vi.fn().mockRejectedValue(new Error('ping timeout'));
    const forceReconnect = vi.fn().mockResolvedValue(undefined);
    const keepalive = new XmppKeepalive(
      { intervalMs: 100, failureThreshold: 2 },
      {
        getState: () => 'online',
        getLastActivityAt: () => 0,
        ping,
        forceReconnect,
        now: () => now,
      },
    );
    keepalive.start();

    await vi.advanceTimersByTimeAsync(100);
    expect(forceReconnect).not.toHaveBeenCalled();
    now = 200;
    await vi.advanceTimersByTimeAsync(100);
    expect(forceReconnect).toHaveBeenCalledOnce();
    expect(forceReconnect).toHaveBeenCalledWith('XEP-0199 keepalive failure threshold reached');
    keepalive.stop();
  });

  it('does not overlap probes while one is still pending', async () => {
    vi.useFakeTimers();
    let resolvePing: (() => void) | undefined;
    const ping = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolvePing = resolve;
        }),
    );
    const keepalive = new XmppKeepalive(
      { intervalMs: 100, failureThreshold: 2 },
      {
        getState: () => 'online',
        getLastActivityAt: () => 0,
        ping,
        forceReconnect: vi.fn(),
        now: () => 1_000,
      },
    );
    keepalive.start();

    await vi.advanceTimersByTimeAsync(300);
    expect(ping).toHaveBeenCalledOnce();
    resolvePing?.();
    await Promise.resolve();
    keepalive.stop();
  });
});
