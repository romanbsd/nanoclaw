#!/usr/bin/env tsx
import assert from 'node:assert/strict';

import type { AgentApiManifest, BridgeFormResponsePayload, BridgeInboundPayload } from '@agent-xmpp/protocol';
import {
  AGENT_API_NS,
  AGENT_DIRECTORY_NS,
  AGENT_OPERATION_NS,
  DISCO_INFO_NS,
  DISCO_ITEMS_NS,
  MCP_ENDPOINT_NS,
  EmbeddedXmppGateway,
  PING_NS,
  VCARD_TEMP_NS,
  buildTaskInvocation,
  operationFromNode,
  parseTaskEvent,
  type ParsedTaskInvocation,
  type TaskWireEvent,
  type GatewayRuntimeMailbox,
} from '@agent-xmpp/gateway';
import { xml, type Element } from '@xmpp/xml';

import { closeDb, getDb, initTestDb, runMigrations } from '../../../src/db/index.js';
import { XmppAgentGatewayStore } from '../../../src/modules/xmpp-agent-gateway/store.js';
import { createXmppAgentIqHandler } from '../../../src/channels/xmpp-agent-iq.js';
import { runOpenfireBootstrap, startOpenfireOnly, stopOpenfireOnly } from './e2e-stack.js';
import { XmppSession } from './xmpp-session.js';

const RECEIPTS_NS = 'urn:xmpp:receipts';

class MailboxSpy implements GatewayRuntimeMailbox {
  readonly inbound: BridgeInboundPayload[] = [];
  readonly forms: BridgeFormResponsePayload[] = [];
  readonly taskInvocations: ParsedTaskInvocation[] = [];
  readonly taskEvents: TaskWireEvent[] = [];
  private waiters: Array<() => void> = [];

  async deliverInbound(payload: BridgeInboundPayload): Promise<void> {
    this.inbound.push(payload);
    this.waiters.splice(0).forEach((resolve) => resolve());
  }

  async deliverFormResponse(payload: BridgeFormResponsePayload): Promise<void> {
    this.forms.push(payload);
  }

  async deliverTaskInvocation(task: ParsedTaskInvocation): Promise<void> {
    this.taskInvocations.push(task);
    this.waiters.splice(0).forEach((resolve) => resolve());
  }

  async deliverTaskEvent(event: TaskWireEvent): Promise<void> {
    this.taskEvents.push(event);
    this.waiters.splice(0).forEach((resolve) => resolve());
  }

  async waitForInbound(count: number, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.inbound.length < count) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`timeout waiting for ${count} mailbox messages`);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting for ${count} mailbox messages`)), remaining);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  async waitForTaskInvocation(timeoutMs = 15_000): Promise<ParsedTaskInvocation> {
    const deadline = Date.now() + timeoutMs;
    while (!this.taskInvocations[0]) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('timeout waiting for task invocation');
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout waiting for task invocation')), remaining);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    return this.taskInvocations[0];
  }
}

function manifest(jid: string, name: string): AgentApiManifest {
  return {
    specVersion: AGENT_API_NS,
    agent: { jid, name, title: name, description: `${name} integration agent`, version: '1.0.0' },
    capabilities: {
      tools: { listChanged: false },
      progress: true,
      cancellation: true,
      inputRequired: true,
      structuredOutput: true,
    },
    operations: [
      {
        name: 'echo',
        title: 'Echo',
        description: 'Echo input',
        inputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
        outputSchema: { type: 'object', required: ['echo'], properties: { echo: { type: 'string' } } },
        annotations: { readOnlyHint: true, idempotentHint: true },
      },
    ],
  };
}

function child(stanza: Element, name: string, xmlns: string): Element | undefined {
  return stanza.getChild(name, xmlns) ?? undefined;
}

async function main(): Promise<void> {
  initTestDb();
  runMigrations(getDb());
  const config = await startOpenfireOnly();
  const componentJid = config.gatewayJid;
  const store = new XmppAgentGatewayStore();
  const agents = [
    store.registerManifest(manifest(`alpha@${componentJid}`, 'alpha'), 'integration-tenant'),
    store.registerManifest(manifest(`beta@${componentJid}`, 'beta'), 'integration-tenant'),
  ];
  const mailbox = new MailboxSpy();
  const iqHandler = createXmppAgentIqHandler({
    componentJid,
    tenantForSender: () => 'integration-tenant',
    store,
  });
  const gateway = new EmbeddedXmppGateway(
    {
      gatewayId: 'integration',
      componentJid,
      agentDomain: componentJid,
      componentService: `xmpp://127.0.0.1:${config.componentPort}`,
      componentSecret: 'component-secret',
      defaultAgentJid: agents[0].manifest.agent.jid,
      receiptTimeoutMs: 250,
      receiptMaxResends: 1,
      receiptSweepMs: 50,
    },
    mailbox,
    iqHandler,
    (jid) => {
      const agent = store.getAgent(jid);
      return agent
        ? { jid: agent.manifest.agent.jid, name: agent.manifest.agent.title ?? agent.manifest.agent.name }
        : null;
    },
  );
  const user = new XmppSession({
    service: config.xmppService,
    domain: config.xmppDomain,
    username: 'john',
    password: 'secret',
    autoReceipts: true,
  });
  let peer: XmppSession | null = null;

  try {
    await gateway.start();
    await user.start();

    process.env.XMPP_PINGER_USER = 'peer-agent';
    process.env.XMPP_PINGER_PASS = 'peer-secret';
    await runOpenfireBootstrap(config);
    peer = new XmppSession({
      service: config.xmppService,
      domain: config.xmppDomain,
      username: 'peer-agent',
      password: 'peer-secret',
      autoReceipts: true,
    });
    await peer.start();

    for (const to of [componentJid, agents[0].manifest.agent.jid, agents[1].manifest.agent.jid]) {
      const id = `ping-${to}-${Date.now()}`;
      const response = user.waitForStanza(
        (stanza) => stanza.is('iq') && stanza.attrs.type === 'result' && stanza.attrs.id === id,
      );
      await user.send(xml('iq', { type: 'get', id, to }, xml('ping', { xmlns: PING_NS })));
      assert.equal((await response).attrs.from, to);
    }

    const subscribed = user.waitForStanza(
      (stanza) =>
        stanza.is('presence') &&
        stanza.attrs.from === agents[0].manifest.agent.jid &&
        stanza.attrs.type === 'subscribed',
    );
    const presence = user.waitForStanza(
      (stanza) => stanza.is('presence') && stanza.attrs.from === agents[0].manifest.agent.jid && !stanza.attrs.type,
    );
    await user.subscribe(agents[0].manifest.agent.jid);
    await subscribed;
    assert.equal((await presence).getChildText('show'), 'chat');

    const reconnectingUser = new XmppSession({
      service: config.xmppService,
      domain: config.xmppDomain,
      username: 'john',
      password: 'secret',
    });
    const presenceAfterReconnect = reconnectingUser.waitForStanza(
      (stanza) => stanza.is('presence') && stanza.attrs.from === agents[0].manifest.agent.jid && !stanza.attrs.type,
    );
    await reconnectingUser.start();
    assert.equal((await presenceAfterReconnect).getChildText('show'), 'chat');
    await reconnectingUser.stop();

    const vcardId = `vcard-${Date.now()}`;
    const vcard = user.waitForStanza((stanza) => stanza.is('iq') && stanza.attrs.id === vcardId);
    await user.send(
      xml('iq', { type: 'get', id: vcardId, to: agents[0].manifest.agent.jid }, xml('vCard', { xmlns: VCARD_TEMP_NS })),
    );
    const card = child(await vcard, 'vCard', VCARD_TEMP_NS);
    assert.equal(card?.getChildText('FN'), agents[0].manifest.agent.title);
    assert.equal(card?.getChildText('JABBERID'), agents[0].manifest.agent.jid);

    await user.sendChat(agents[0].manifest.agent.jid, 'for alpha', 'alpha-message');
    await user.sendChat(agents[1].manifest.agent.jid, 'for beta', 'beta-message');
    await mailbox.waitForInbound(2);
    assert.deepEqual(
      mailbox.inbound.map((message) => [message.agentJid, message.message.content.text]),
      [
        [agents[0].manifest.agent.jid, 'for alpha'],
        [agents[1].manifest.agent.jid, 'for beta'],
      ],
    );
    assert.match(mailbox.inbound[0].replyTo ?? '', /^john@example\.org\/.+/);

    const receiptRequestId = `receipt-request-${Date.now()}`;
    const inboundReceipt = user.waitForStanza(
      (stanza) => stanza.is('message') && stanza.getChild('received', RECEIPTS_NS)?.attrs.id === receiptRequestId,
    );
    await user.send(
      xml(
        'message',
        { type: 'chat', to: agents[0].manifest.agent.jid, id: receiptRequestId },
        xml('body', {}, 'receipt-requested inbound'),
        xml('request', { xmlns: RECEIPTS_NS }),
      ),
    );
    await mailbox.waitForInbound(3);
    assert.equal((await inboundReceipt).attrs.from, agents[0].manifest.agent.jid);

    const resourceReplies = user.collectStanzas(
      (stanza) => stanza.is('message') && stanza.getChildText('body') === 'resource-specific reply',
      650,
    );
    await gateway.deliver({
      from: agents[0].manifest.agent.jid,
      to: mailbox.inbound[0].replyTo!,
      content: 'resource-specific reply',
    });
    const deliveredResourceReplies = await resourceReplies;
    assert.equal(deliveredResourceReplies.length, 1, 'a fast delivery receipt must prevent retries');
    assert.equal(deliveredResourceReplies[0].attrs.to, mailbox.inbound[0].replyTo);
    assert.ok(deliveredResourceReplies[0].getChild('request', RECEIPTS_NS));

    user.setAutoReceipts(false);
    const restartBody = `receipt restart ${Date.now()}`;
    const restartDeliveries = user.collectStanzas(
      (stanza) => stanza.is('message') && stanza.getChildText('body') === restartBody,
      650,
    );
    const firstRestartDelivery = user.waitForBody(restartBody);
    await gateway.deliver({
      from: agents[0].manifest.agent.jid,
      to: mailbox.inbound[0].replyTo!,
      content: restartBody,
    });
    await firstRestartDelivery;
    await gateway.stop();
    await gateway.start();
    assert.equal((await restartDeliveries).length, 1, 'gateway restart must clear prior-session receipt state');
    user.setAutoReceipts(true);

    await gateway.deliver({
      from: agents[0].manifest.agent.jid,
      to: agents[1].manifest.agent.jid,
      content: 'alpha to beta',
    });
    await mailbox.waitForInbound(4);
    assert.equal(mailbox.inbound[3].agentJid, agents[1].manifest.agent.jid);
    assert.equal(mailbox.inbound[3].platformId, agents[0].manifest.agent.jid);
    assert.equal(mailbox.inbound[3].message.content.text, 'alpha to beta');

    await peer.send(
      buildTaskInvocation({
        taskId: 'remote-task-1',
        rootTaskId: 'remote-task-1',
        callerJid: 'peer-agent@example.org',
        targetJid: agents[1].manifest.agent.jid,
        tenantId: 'integration-tenant',
        endpointId: `xmpp+mcp://${agents[1].manifest.agent.jid}`,
        operation: 'echo',
        apiVersion: '1.0.0',
        inputSchemaDigest: agents[1].operations[0].inputSchemaDigest,
        outputSchemaDigest: agents[1].operations[0].outputSchemaDigest,
        arguments: { text: 'remote task' },
        state: 'accepted',
        attempt: 1,
        correlationId: 'remote-correlation-1',
        createdAt: new Date().toISOString(),
      }),
    );
    assert.equal((await mailbox.waitForTaskInvocation()).toJid, agents[1].manifest.agent.jid);

    const taskResult = peer.waitForStanza((stanza) => parseTaskEvent(stanza)?.taskId === 'remote-task-1');
    await gateway.deliverTaskEvent({
      taskId: 'remote-task-1',
      type: 'completed',
      from: agents[1].manifest.agent.jid,
      to: 'peer-agent@example.org',
      payload: { result: { echo: 'remote task' } },
    });
    assert.deepEqual(parseTaskEvent(await taskResult)?.payload, { result: { echo: 'remote task' } });

    const reply = user.waitForBody('alpha reply');
    await gateway.deliver({
      from: agents[0].manifest.agent.jid,
      to: config.pingerJid,
      content: 'alpha reply',
    });
    assert.equal((await reply).attrs.from, agents[0].manifest.agent.jid);

    const directoryId = `directory-${Date.now()}`;
    const gatewayInfoId = `gateway-info-${Date.now()}`;
    const gatewayInfo = peer.waitForStanza((stanza) => stanza.is('iq') && stanza.attrs.id === gatewayInfoId);
    await peer.send(
      xml('iq', { type: 'get', id: gatewayInfoId, to: componentJid }, xml('query', { xmlns: DISCO_INFO_NS })),
    );
    const gatewayFeatures =
      child(await gatewayInfo, 'query', DISCO_INFO_NS)
        ?.getChildren('feature')
        .map((feature) => feature.attrs.var) ?? [];
    assert.ok(gatewayFeatures.includes(AGENT_API_NS));
    assert.ok(gatewayFeatures.includes(AGENT_DIRECTORY_NS));

    const directory = peer.waitForStanza((stanza) => stanza.is('iq') && stanza.attrs.id === directoryId);
    await peer.send(
      xml(
        'iq',
        { type: 'get', id: directoryId, to: componentJid },
        xml('query', { xmlns: DISCO_ITEMS_NS, node: AGENT_DIRECTORY_NS }),
      ),
    );
    const items = child(await directory, 'query', DISCO_ITEMS_NS)?.getChildren('item') ?? [];
    assert.deepEqual(
      items.map((item) => item.attrs.jid),
      agents.map((agent) => agent.manifest.agent.jid),
    );

    const infoId = `info-${Date.now()}`;
    const info = peer.waitForStanza((stanza) => stanza.is('iq') && stanza.attrs.id === infoId);
    await peer.send(
      xml(
        'iq',
        { type: 'get', id: infoId, to: agents[1].manifest.agent.jid },
        xml('query', { xmlns: DISCO_INFO_NS, node: MCP_ENDPOINT_NS }),
      ),
    );
    const endpointQuery = child(await info, 'query', DISCO_INFO_NS);
    assert.equal(endpointQuery?.getChild('identity')?.attrs.type, 'mcp-endpoint');
    assert.ok(endpointQuery?.toString().includes('manifest_digest'));
    assert.ok(endpointQuery?.toString().includes(agents[1].manifestDigest));

    const operationListId = `operations-${Date.now()}`;
    const operationList = peer.waitForStanza((stanza) => stanza.is('iq') && stanza.attrs.id === operationListId);
    await peer.send(
      xml(
        'iq',
        { type: 'get', id: operationListId, to: agents[1].manifest.agent.jid },
        xml('query', { xmlns: DISCO_ITEMS_NS, node: AGENT_API_NS }),
      ),
    );
    const operationItem = child(await operationList, 'query', DISCO_ITEMS_NS)?.getChild('item');
    assert.equal(operationFromNode(String(operationItem?.attrs.node)), 'echo');

    const operationInfoId = `operation-info-${Date.now()}`;
    const operationInfo = peer.waitForStanza((stanza) => stanza.is('iq') && stanza.attrs.id === operationInfoId);
    await peer.send(
      xml(
        'iq',
        { type: 'get', id: operationInfoId, to: agents[1].manifest.agent.jid },
        xml('query', { xmlns: DISCO_INFO_NS, node: operationItem?.attrs.node }),
      ),
    );
    const operationXml = (await operationInfo).toString();
    assert.ok(operationXml.includes(AGENT_OPERATION_NS));
    assert.ok(operationXml.includes(agents[1].operations[0].inputSchemaDigest));
    assert.ok(operationXml.includes('idempotent'));

    for (const direction of ['input', 'output'] as const) {
      const schemaId = `schema-${direction}-${Date.now()}`;
      const schemaResult = peer.waitForStanza((stanza) => stanza.is('iq') && stanza.attrs.id === schemaId);
      await peer.send(
        xml(
          'iq',
          { type: 'get', id: schemaId, to: agents[1].manifest.agent.jid },
          xml('schema', { xmlns: AGENT_API_NS, operation: 'echo', direction }),
        ),
      );
      const schema = child(await schemaResult, 'schema', AGENT_API_NS);
      assert.equal(
        schema?.attrs.digest,
        direction === 'input' ? agents[1].operations[0].inputSchemaDigest : agents[1].operations[0].outputSchemaDigest,
      );
      assert.equal(JSON.parse(schema?.getText() ?? '{}').type, 'object');
    }

    assert.equal(mailbox.inbound.length, 4, 'IQ ping and discovery must not wake agents');
    console.log(
      '[e2e] embedded gateway: ping, presence, receipts/restart, vCard, human/agent, agent/agent, discovery, and remote task lifecycle passed',
    );
  } finally {
    await user.stop().catch(() => undefined);
    await peer?.stop().catch(() => undefined);
    await gateway.stop().catch(() => undefined);
    await stopOpenfireOnly();
    closeDb();
  }
}

main().catch((error) => {
  console.error('[e2e] embedded gateway failed:', error);
  process.exitCode = 1;
});
