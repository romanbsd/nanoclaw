import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from './config.js';

const RECEIPT_KEYS = ['XMPP_RECEIPT_TIMEOUT_MS', 'XMPP_RECEIPT_MAX_RESENDS', 'XMPP_RECEIPT_SWEEP_MS'];
const CONNECTION_KEYS = [
  'XMPP_SERVER_DOMAIN',
  'XMPP_RECONNECT_INITIAL_MS',
  'XMPP_RECONNECT_MAX_MS',
  'XMPP_PING_INTERVAL_MS',
  'XMPP_PING_TIMEOUT_MS',
  'XMPP_PING_FAILURE_THRESHOLD',
];

describe('loadConfig receipt knobs', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of [...RECEIPT_KEYS, ...CONNECTION_KEYS, 'XMPP_COMPONENT_JID', 'XMPP_COMPONENT_SECRET']) {
      saved[k] = process.env[k];
    }
    for (const k of [...RECEIPT_KEYS, ...CONNECTION_KEYS]) delete process.env[k];
    process.env.XMPP_COMPONENT_JID = 'gw.agents.test';
    process.env.XMPP_COMPONENT_SECRET = 'secret';
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('defaults to observe-only (no resend) with sane intervals', () => {
    const c = loadConfig();
    expect(c.receiptMaxResends).toBe(0);
    expect(c.receiptTimeoutMs).toBe(30_000);
    expect(c.receiptSweepMs).toBe(10_000);
    expect(c.serverDomain).toBe('agents.test');
    expect(c.reconnectInitialMs).toBe(1_000);
    expect(c.reconnectMaxMs).toBe(60_000);
    expect(c.pingIntervalMs).toBe(60_000);
    expect(c.pingTimeoutMs).toBe(10_000);
    expect(c.pingFailureThreshold).toBe(2);
  });

  it('rejects a zero sweep interval (would busy-loop) and falls back', () => {
    process.env.XMPP_RECEIPT_SWEEP_MS = '0';
    expect(loadConfig().receiptSweepMs).toBe(10_000);
  });

  it('rejects zero/negative/non-integer timeout, keeps positive integers', () => {
    process.env.XMPP_RECEIPT_TIMEOUT_MS = '0';
    expect(loadConfig().receiptTimeoutMs).toBe(30_000);
    process.env.XMPP_RECEIPT_TIMEOUT_MS = '-5';
    expect(loadConfig().receiptTimeoutMs).toBe(30_000);
    process.env.XMPP_RECEIPT_TIMEOUT_MS = '1.5';
    expect(loadConfig().receiptTimeoutMs).toBe(30_000);
    process.env.XMPP_RECEIPT_TIMEOUT_MS = '5000';
    expect(loadConfig().receiptTimeoutMs).toBe(5000);
  });

  it('allows maxResends=0 as meaningful but rejects negatives/non-integers', () => {
    process.env.XMPP_RECEIPT_MAX_RESENDS = '0';
    expect(loadConfig().receiptMaxResends).toBe(0);
    process.env.XMPP_RECEIPT_MAX_RESENDS = '3';
    expect(loadConfig().receiptMaxResends).toBe(3);
    process.env.XMPP_RECEIPT_MAX_RESENDS = '-1';
    expect(loadConfig().receiptMaxResends).toBe(0);
    process.env.XMPP_RECEIPT_MAX_RESENDS = 'abc';
    expect(loadConfig().receiptMaxResends).toBe(0);
  });

  it('loads connection supervision knobs and clamps reconnect max to initial', () => {
    process.env.XMPP_SERVER_DOMAIN = 'example.test';
    process.env.XMPP_RECONNECT_INITIAL_MS = '5000';
    process.env.XMPP_RECONNECT_MAX_MS = '1000';
    process.env.XMPP_PING_INTERVAL_MS = '30000';
    process.env.XMPP_PING_TIMEOUT_MS = '4000';
    process.env.XMPP_PING_FAILURE_THRESHOLD = '3';
    const c = loadConfig();
    expect(c.serverDomain).toBe('example.test');
    expect(c.reconnectInitialMs).toBe(5000);
    expect(c.reconnectMaxMs).toBe(5000);
    expect(c.pingIntervalMs).toBe(30000);
    expect(c.pingTimeoutMs).toBe(4000);
    expect(c.pingFailureThreshold).toBe(3);
  });
});
