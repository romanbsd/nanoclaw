import type { GatewayConfig } from './config.js';

const lastActivity = new Map<string, number>();

export function touchActivity(jid: string): void {
  lastActivity.set(jid, Date.now());
}

export function getLastActivity(jid: string): number | undefined {
  return lastActivity.get(jid);
}

export function shouldWake(_config: GatewayConfig, _kind: string): boolean {
  return true;
}
