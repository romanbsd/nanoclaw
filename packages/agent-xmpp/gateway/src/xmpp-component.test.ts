import { component } from '@xmpp/component';
import { xml, type Element } from '@xmpp/xml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GatewayConfig } from './config.js';
import { createComponentSession, IqResponseError } from './xmpp-component.js';

vi.mock('@xmpp/component', () => ({ component: vi.fn() }));

type StanzaHandler = (stanza: Element) => void;
type ErrorHandler = (error: Error) => void;
type OfflineHandler = () => void;

interface MockComponentClient {
  handlers: {
    stanza?: StanzaHandler;
    error?: ErrorHandler;
    offline?: OfflineHandler;
    online?: OfflineHandler;
  };
  on: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}

const config: GatewayConfig = {
  gatewayId: 'test-gateway',
  componentJid: 'gateway.agents.test',
  agentDomain: 'agents.test',
  componentService: 'xmpp://127.0.0.1:5275',
  componentSecret: 'secret',
  defaultAgentJid: 'assistant@agents.test',
  receiptTimeoutMs: 30_000,
  receiptMaxResends: 0,
  receiptSweepMs: 10_000,
};

function createMockClient(): MockComponentClient {
  const client: MockComponentClient = {
    handlers: {},
    on: vi.fn(),
    send: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  };
  client.on.mockImplementation((event: keyof MockComponentClient['handlers'], handler: never) => {
    client.handlers[event] = handler;
    return client;
  });
  return client;
}

describe('XmppComponentSession outbound IQ requests', () => {
  let client: MockComponentClient;

  beforeEach(() => {
    client = createMockClient();
    vi.mocked(component).mockReturnValue(client as unknown as ReturnType<typeof component>);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('assigns an id, correlates the result, and leaves unsolicited responses dispatchable', async () => {
    const session = createComponentSession(config);
    const onStanza = vi.fn();
    session.onStanza(onStanza);
    const request = xml('iq', { type: 'get', to: 'upload.test' }, xml('query', { xmlns: 'test:query' }));

    const responsePromise = session.requestIq(request);
    const id = String(request.attrs.id);
    expect(id).not.toBe('');
    expect(client.send).toHaveBeenCalledWith(request);

    const unsolicited = xml('iq', { type: 'result', id: 'someone-elses-request' });
    client.handlers.stanza?.(unsolicited);
    expect(onStanza).toHaveBeenCalledWith(unsolicited);
    const unsolicitedError = xml('iq', { type: 'error', id: 'someone-elses-error' });
    client.handlers.stanza?.(unsolicitedError);
    expect(onStanza).toHaveBeenCalledWith(unsolicitedError);

    const response = xml('iq', { type: 'result', id });
    client.handlers.stanza?.(response);
    await expect(responsePromise).resolves.toBe(response);
    expect(onStanza).toHaveBeenCalledTimes(2);
  });

  it('rejects an IQ error with the response attached', async () => {
    const session = createComponentSession(config);
    const request = xml('iq', { type: 'get', id: 'iq-error' });
    const responsePromise = session.requestIq(request);
    const response = xml(
      'iq',
      { type: 'error', id: 'iq-error' },
      xml('error', { type: 'cancel' }, xml('service-unavailable', { xmlns: 'urn:ietf:params:xml:ns:xmpp-stanzas' })),
    );

    client.handlers.stanza?.(response);

    const error = await responsePromise.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(IqResponseError);
    expect((error as IqResponseError).response).toBe(response);
    expect((error as Error).message).toContain('service-unavailable');
  });

  it('registers before send so a synchronous response cannot be lost', async () => {
    const session = createComponentSession(config);
    const request = xml('iq', { type: 'get', id: 'fast-response' });
    const response = xml('iq', { type: 'result', id: 'fast-response' });
    client.send.mockImplementationOnce(async () => {
      client.handlers.stanza?.(response);
    });

    await expect(session.requestIq(request)).resolves.toBe(response);
  });

  it('times out and permits the same id to be reused after cleanup', async () => {
    vi.useFakeTimers();
    const session = createComponentSession(config);
    const first = session.requestIq(xml('iq', { type: 'get', id: 'reusable' }), { timeoutMs: 25 });
    const timedOut = expect(first).rejects.toThrow('timed out after 25ms');

    await vi.advanceTimersByTimeAsync(25);
    await timedOut;

    const second = session.requestIq(xml('iq', { type: 'get', id: 'reusable' }), { timeoutMs: 25 });
    const response = xml('iq', { type: 'result', id: 'reusable' });
    client.handlers.stanza?.(response);
    await expect(second).resolves.toBe(response);
  });

  it('removes pending state when the initial send fails', async () => {
    const session = createComponentSession(config);
    client.send.mockRejectedValueOnce(new Error('socket closed'));
    await expect(session.requestIq(xml('iq', { type: 'set', id: 'send-failure' }))).rejects.toThrow('socket closed');

    const retry = session.requestIq(xml('iq', { type: 'set', id: 'send-failure' }));
    const response = xml('iq', { type: 'result', id: 'send-failure' });
    client.handlers.stanza?.(response);
    await expect(retry).resolves.toBe(response);
  });

  it('supports abort signals and does not send an already-aborted request', async () => {
    const session = createComponentSession(config);
    const activeController = new AbortController();
    const active = session.requestIq(xml('iq', { type: 'get', id: 'active-abort' }), {
      signal: activeController.signal,
    });
    activeController.abort();
    await expect(active).rejects.toMatchObject({ name: 'AbortError' });

    const abortedController = new AbortController();
    abortedController.abort();
    const callsBefore = client.send.mock.calls.length;
    await expect(
      session.requestIq(xml('iq', { type: 'get', id: 'pre-aborted' }), { signal: abortedController.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(client.send).toHaveBeenCalledTimes(callsBefore);
  });

  it('rejects all pending requests when stopped or disconnected', async () => {
    const session = createComponentSession(config);
    const stopped = session.requestIq(xml('iq', { type: 'get', id: 'stopped' }));
    await session.stop();
    await expect(stopped).rejects.toThrow('component stopped');
    await expect(session.requestIq(xml('iq', { type: 'get', id: 'after-stop' }))).rejects.toThrow(
      'component is offline',
    );

    client.handlers.online?.();

    const offline = session.requestIq(xml('iq', { type: 'get', id: 'offline' }));
    client.handlers.offline?.();
    await expect(offline).rejects.toThrow('component went offline');
    await expect(session.requestIq(xml('iq', { type: 'get', id: 'after-offline' }))).rejects.toThrow(
      'component is offline',
    );
  });

  it('rejects invalid requests, duplicate ids, and requests beyond the pending cap', async () => {
    const session = createComponentSession(config);
    await expect(session.requestIq(xml('message', { id: 'not-iq' }))).rejects.toThrow('must be an <iq');
    await expect(session.requestIq(xml('iq', { type: 'result', id: 'not-request' }))).rejects.toThrow('must be an <iq');
    await expect(session.requestIq(xml('iq', { type: 'get' }), { timeoutMs: 0 })).rejects.toThrow('positive integer');

    const pending = session.requestIq(xml('iq', { type: 'get', id: 'duplicate' }));
    await expect(session.requestIq(xml('iq', { type: 'get', id: 'duplicate' }))).rejects.toThrow('already pending');

    const capped = Array.from({ length: 255 }, (_, index) =>
      session.requestIq(xml('iq', { type: 'get', id: `capped-${index}` })),
    );
    await expect(session.requestIq(xml('iq', { type: 'get', id: 'over-cap' }))).rejects.toThrow(
      'Too many pending IQ requests',
    );

    client.handlers.offline?.();
    await Promise.allSettled([pending, ...capped]);
  });
});
