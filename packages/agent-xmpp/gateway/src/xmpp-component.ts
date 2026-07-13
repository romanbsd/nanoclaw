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
  onStanza: (handler: (stanza: Element) => void) => void;
}

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

export function createComponentSession(config: GatewayConfig, onIqGet?: IqGetHandler): XmppComponentSession {
  const xmpp = component({
    service: config.componentService,
    domain: config.componentJid,
    password: config.componentSecret,
  });

  const stanzaHandlers: Array<(stanza: Element) => void> = [];
  const pendingIqRequests = new Map<string, PendingIqRequest>();
  let acceptsIqRequests = true;

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

  xmpp.on('stanza', (stanza: Element) => {
    const disposition = dispositionForStanza(stanza, onIqGet);
    if (disposition.kind !== 'dispatch') {
      const reply = disposition.kind === 'respond' ? disposition.stanza : buildIqError(stanza);
      xmpp.send(reply).catch((err) => {
        console.error(`[xmpp-gateway] IQ ${disposition.kind} send failed:`, err);
      });
      return;
    }

    const type = String(stanza.attrs.type ?? '');
    const id = String(stanza.attrs.id ?? '');
    if (stanza.name === 'iq' && id && (type === 'result' || type === 'error') && settleIqRequest(id, stanza)) {
      return;
    }
    for (const h of stanzaHandlers) h(stanza);
  });

  xmpp.on('error', (err: Error) => {
    console.error('[xmpp-gateway] component error:', err.message);
  });

  xmpp.on('offline', () => {
    acceptsIqRequests = false;
    rejectPendingIqRequests('component went offline');
  });

  xmpp.on('online', () => {
    acceptsIqRequests = true;
  });

  const requestIq = (stanza: Element, options: IqRequestOptions = {}): Promise<Element> => {
    if (!acceptsIqRequests) return Promise.reject(new Error('Cannot send IQ request while component is offline'));

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
        xmpp.send(stanza).catch((error: unknown) => {
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
    send: (stanza) => xmpp.send(stanza),
    requestIq,
    start: async () => {
      await xmpp.start();
      acceptsIqRequests = true;
      console.error(`[xmpp-gateway] component online: ${config.componentJid}`);
    },
    stop: async () => {
      acceptsIqRequests = false;
      rejectPendingIqRequests('component stopped');
      await xmpp.stop();
    },
    onStanza: (handler) => {
      stanzaHandlers.push(handler);
    },
  };
}

export { xml };
