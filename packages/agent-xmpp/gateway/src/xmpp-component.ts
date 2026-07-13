/**
 * External-component session using XEP-0114 Jabber Component Protocol.
 * @see https://xmpp.org/extensions/xep-0114.html
 */
import { component } from '@xmpp/component';
import { xml, type Element } from '@xmpp/xml';
import { ulid } from 'ulid';

import type { GatewayConfig } from './config.js';

export interface XmppComponentSession {
  send: (stanza: Element) => Promise<void>;
  requestIq: (stanza: Element, options?: IqRequestOptions) => Promise<Element>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  forceReconnect: (reason: string) => Promise<void>;
  getState: () => XmppConnectionState;
  getLastActivityAt: () => number;
  onStateChange: (handler: (state: XmppConnectionState) => void) => void;
  onStanza: (handler: (stanza: Element) => void) => void;
}

export type XmppConnectionState = 'offline' | 'connecting' | 'online' | 'stopping';

export interface IqRequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class IqResponseError extends Error {
  constructor(public readonly response: Element) {
    const id = String(response.attrs.id ?? 'unknown');
    const stanzaError = response.getChild('error');
    const condition = stanzaError?.children.find(
      (child): child is Element => typeof child !== 'string' && child.name !== 'text',
    );
    super(`IQ request ${id} failed${condition ? `: ${condition.name}` : ''}`);
    this.name = 'IqResponseError';
  }
}

export type IqGetHandler = (stanza: Element) => Element | null;

const STANZA_ERROR_NS = 'urn:ietf:params:xml:ns:xmpp-stanzas';
const DEFAULT_IQ_TIMEOUT_MS = 30_000;
const MAX_PENDING_IQ_REQUESTS = 256;

interface PendingIqRequest {
  resolve: (stanza: Element) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
}

function abortError(id: string): Error {
  const error = new Error(`IQ request ${id} aborted`);
  error.name = 'AbortError';
  return error;
}

/**
 * RFC 6120 §8.3 stanza error for an IQ get/set the gateway does not handle.
 * `service-unavailable` (type cancel) is the standard "no such handler" reply;
 * the original request payload is echoed back per the SHOULD in §8.3.1.
 */
export function buildIqError(request: Element): Element {
  return xml(
    'iq',
    { type: 'error', id: request.attrs.id, from: request.attrs.to, to: request.attrs.from },
    ...request.children.filter((c): c is Element => typeof c !== 'string'),
    xml('error', { type: 'cancel' }, xml('service-unavailable', { xmlns: STANZA_ERROR_NS })),
  );
}

export type IqDisposition =
  | { kind: 'respond'; stanza: Element }
  | { kind: 'error' }
  | { kind: 'dispatch' };

/**
 * Decide how an inbound stanza is handled by the component:
 *  - IQ get/set the gateway answers    -> `respond` with the built reply
 *  - IQ get/set nothing handled        -> `error` (RFC 6120 §8.2.3 requires a reply)
 *  - everything else, incl. IQ result/error responses to our own outbound requests
 *    and all message/presence stanzas  -> `dispatch` to the registered stanza handlers
 */
export function dispositionForStanza(stanza: Element, onIqGet?: IqGetHandler): IqDisposition {
  if (stanza.name === 'iq') {
    const type = String(stanza.attrs.type ?? '');
    if (type === 'get' || type === 'set') {
      const response = onIqGet?.(stanza) ?? null;
      return response ? { kind: 'respond', stanza: response } : { kind: 'error' };
    }
  }
  return { kind: 'dispatch' };
}

export function reconnectDelayMs(attempt: number, initialMs: number, maxMs: number, random = Math.random): number {
  const exponential = Math.min(maxMs, initialMs * 2 ** Math.min(Math.max(attempt - 1, 0), 30));
  return Math.max(1, Math.round(exponential * (0.8 + random() * 0.4)));
}

export function createComponentSession(config: GatewayConfig, onIqGet?: IqGetHandler): XmppComponentSession {
  const stanzaHandlers: Array<(stanza: Element) => void> = [];
  const stateHandlers: Array<(state: XmppConnectionState) => void> = [];
  const pendingIqRequests = new Map<string, PendingIqRequest>();
  let activeClient: ReturnType<typeof component> | null = null;
  let state: XmppConnectionState = 'offline';
  let stopped = true;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let lastActivityAt = Date.now();
  let onlineAttempt: {
    client: ReturnType<typeof component>;
    resolve: () => void;
    reject: (error: Error) => void;
  } | null = null;

  const transition = (next: XmppConnectionState): void => {
    if (state === next) return;
    state = next;
    for (const handler of stateHandlers) handler(next);
  };

  const settleIqRequest = (id: string, responseOrError: Element | Error): boolean => {
    const pending = pendingIqRequests.get(id);
    if (!pending) return false;

    pendingIqRequests.delete(id);
    clearTimeout(pending.timer);
    if (pending.signal && pending.onAbort) pending.signal.removeEventListener('abort', pending.onAbort);

    if (responseOrError instanceof Error) pending.reject(responseOrError);
    else if (responseOrError.attrs.type === 'error') pending.reject(new IqResponseError(responseOrError));
    else pending.resolve(responseOrError);
    return true;
  };

  const rejectPendingIqRequests = (reason: string): void => {
    for (const id of [...pendingIqRequests.keys()]) {
      settleIqRequest(id, new Error(`IQ request ${id} failed: ${reason}`));
    }
  };

  const rejectOnlineAttempt = (client: ReturnType<typeof component>, reason: Error): void => {
    if (onlineAttempt?.client !== client) return;
    const attempt = onlineAttempt;
    onlineAttempt = null;
    attempt.reject(reason);
  };

  const clearReconnectTimer = (): void => {
    if (!reconnectTimer) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  };

  const scheduleReconnect = (): void => {
    if (stopped || reconnectTimer) return;
    reconnectAttempt += 1;
    const delay = reconnectDelayMs(reconnectAttempt, config.reconnectInitialMs, config.reconnectMaxMs);
    console.error(`[xmpp-gateway] reconnect attempt ${reconnectAttempt} scheduled in ${delay}ms`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connectClient();
    }, delay);
    reconnectTimer.unref?.();
  };

  const handleConnectionLoss = (client: ReturnType<typeof component>, reason: string): void => {
    if (activeClient !== client || stopped || state === 'stopping') return;
    activeClient = null;
    transition('offline');
    rejectOnlineAttempt(client, new Error(reason));
    rejectPendingIqRequests(reason);
    scheduleReconnect();
  };

  const createClient = (): ReturnType<typeof component> => {
    const client = component({
      service: config.componentService,
      domain: config.componentJid,
      password: config.componentSecret,
    });
    // The package helper makes only one fixed-delay attempt. The gateway owns a
    // capped, jittered supervisor and creates a clean client for every attempt.
    client.reconnect.stop();

    client.on('stanza', (stanza: Element) => {
      if (activeClient !== client) return;
      lastActivityAt = Date.now();
      const disposition = dispositionForStanza(stanza, onIqGet);
      if (disposition.kind !== 'dispatch') {
        const reply = disposition.kind === 'respond' ? disposition.stanza : buildIqError(stanza);
        client
          .send(reply)
          .then(() => {
            lastActivityAt = Date.now();
          })
          .catch((err) => {
            console.error(`[xmpp-gateway] IQ ${disposition.kind} send failed:`, err);
          });
        return;
      }

      const type = String(stanza.attrs.type ?? '');
      const id = String(stanza.attrs.id ?? '');
      if (stanza.name === 'iq' && id && (type === 'result' || type === 'error') && settleIqRequest(id, stanza)) {
        return;
      }
      for (const handler of stanzaHandlers) handler(stanza);
    });

    client.on('error', (err: Error) => {
      if (activeClient === client) {
        console.error('[xmpp-gateway] component error:', err.message);
        rejectOnlineAttempt(client, err);
      }
    });
    client.on('online', () => {
      if (activeClient !== client || stopped) return;
      reconnectAttempt = 0;
      clearReconnectTimer();
      lastActivityAt = Date.now();
      transition('online');
      if (onlineAttempt?.client === client) {
        const attempt = onlineAttempt;
        onlineAttempt = null;
        attempt.resolve();
      }
    });
    client.on('disconnect', () => handleConnectionLoss(client, 'component disconnected'));
    client.on('offline', () => handleConnectionLoss(client, 'component went offline'));
    return client;
  };

  async function connectClient(): Promise<void> {
    if (stopped || state === 'connecting' || state === 'online') return;
    transition('connecting');
    const client = createClient();
    activeClient = client;
    try {
      // Avoid Component.start(): @xmpp/connection creates an internal
      // `online` promise before `open()`, and both promises reject on a
      // connection error. Only one is awaited upstream, producing an
      // unhandled rejection during ordinary reconnect failures.
      await client.connect(config.componentService);
      const onlinePromise = new Promise<void>((resolve, reject) => {
        onlineAttempt = { client, resolve, reject };
      });
      try {
        await client.open({ domain: config.componentJid });
        await onlinePromise;
      } catch (error: unknown) {
        rejectOnlineAttempt(client, error instanceof Error ? error : new Error(String(error)));
        await onlinePromise.catch(() => undefined);
        throw error;
      }
      if (activeClient === client && !stopped) {
        reconnectAttempt = 0;
        lastActivityAt = Date.now();
        transition('online');
        console.error(`[xmpp-gateway] component online: ${config.componentJid}`);
      }
    } catch (error: unknown) {
      if (activeClient === client) activeClient = null;
      client.reconnect.stop();
      transition('offline');
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[xmpp-gateway] component connection failed: ${message}`);
      scheduleReconnect();
      await client.stop().catch(() => undefined);
    }
  }

  const send = async (stanza: Element): Promise<void> => {
    const client = activeClient;
    if (state !== 'online' || !client) throw new Error('XMPP component is offline');
    await client.send(stanza);
    lastActivityAt = Date.now();
  };

  const requestIq = (stanza: Element, options: IqRequestOptions = {}): Promise<Element> => {
    if (state !== 'online') return Promise.reject(new Error('Cannot send IQ request while component is offline'));

    const type = String(stanza.attrs.type ?? '');
    if (stanza.name !== 'iq' || (type !== 'get' && type !== 'set')) {
      return Promise.reject(new Error('Outbound IQ request must be an <iq type="get"> or <iq type="set"> stanza'));
    }

    const timeoutMs = options.timeoutMs ?? DEFAULT_IQ_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || !Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      return Promise.reject(new Error('IQ request timeoutMs must be a positive integer'));
    }
    if (pendingIqRequests.size >= MAX_PENDING_IQ_REQUESTS) {
      return Promise.reject(new Error(`Too many pending IQ requests (limit ${MAX_PENDING_IQ_REQUESTS})`));
    }

    const id = String(stanza.attrs.id ?? '') || ulid();
    if (pendingIqRequests.has(id)) {
      return Promise.reject(new Error(`IQ request id is already pending: ${id}`));
    }
    stanza.attrs.id = id;

    if (options.signal?.aborted) return Promise.reject(abortError(id));

    return new Promise<Element>((resolve, reject) => {
      const timer = setTimeout(() => {
        settleIqRequest(id, new Error(`IQ request ${id} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();

      const pending: PendingIqRequest = { resolve, reject, timer, signal: options.signal };
      if (options.signal) {
        pending.onAbort = () => settleIqRequest(id, abortError(id));
        options.signal.addEventListener('abort', pending.onAbort, { once: true });
      }
      pendingIqRequests.set(id, pending);

      try {
        send(stanza).catch((error: unknown) => {
          const sendError = error instanceof Error ? error : new Error(String(error));
          settleIqRequest(id, sendError);
        });
      } catch (error: unknown) {
        const sendError = error instanceof Error ? error : new Error(String(error));
        settleIqRequest(id, sendError);
      }
    });
  };

  return {
    send,
    requestIq,
    start: async () => {
      if (!stopped) return;
      stopped = false;
      reconnectAttempt = 0;
      clearReconnectTimer();
      await connectClient();
    },
    stop: async () => {
      if (stopped && state === 'offline') return;
      stopped = true;
      clearReconnectTimer();
      transition('stopping');
      rejectPendingIqRequests('component stopped');
      const client = activeClient;
      activeClient = null;
      if (client) rejectOnlineAttempt(client, new Error('component stopped'));
      client?.reconnect.stop();
      if (client) await client.stop().catch(() => undefined);
      transition('offline');
    },
    forceReconnect: async (reason) => {
      if (stopped || state === 'stopping') return;
      const client = activeClient;
      activeClient = null;
      transition('offline');
      if (client) rejectOnlineAttempt(client, new Error(reason));
      rejectPendingIqRequests(reason);
      client?.reconnect.stop();
      if (client) await client.stop().catch(() => undefined);
      scheduleReconnect();
    },
    getState: () => state,
    getLastActivityAt: () => lastActivityAt,
    onStateChange: (handler) => stateHandlers.push(handler),
    onStanza: (handler) => {
      stanzaHandlers.push(handler);
    },
  };
}

export { xml };
