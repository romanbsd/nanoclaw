/** Normative types from Agent XMPP Adapter API Surface v0.1 */

export type MessageKind =
  | 'text'
  | 'task'
  | 'result'
  | 'error'
  | 'file'
  | 'command'
  | 'event';

export type Sensitivity = 'public' | 'internal' | 'confidential' | 'secret';

export interface TraceContext {
  tenantId?: string;
  workflowId?: string;
  runId?: string;
  spanId?: string;
  correlationId?: string;
}

export interface MessagePolicy {
  store?: boolean;
  ttlSeconds?: number | null;
  trainingAllowed?: boolean;
  containsPii?: boolean;
  sensitivity?: Sensitivity;
}

export interface FileRef {
  id?: string;
  name?: string;
  url: string;
  mediaType?: string;
  sizeBytes?: number;
  sha256?: string;
  description?: string;
  expiresAt?: string;
  encrypted?: boolean;
  metadata?: Record<string, unknown>;
}

export interface AgentMessage {
  id: string;
  from: string;
  to: string;
  threadId?: string;
  roomId?: string;
  kind: MessageKind;
  contentType: string;
  body: unknown;
  replyTo?: string;
  attachments?: FileRef[];
  trace?: TraceContext;
  policy?: MessagePolicy;
  extensions?: Record<string, unknown>;
}

export interface XmppSourceMetadata {
  stanzaId?: string;
  stableId?: string;
  stanzaType?: 'chat' | 'groupchat' | 'normal' | 'headline' | 'error';
  fromResource?: string;
  toResource?: string;
  mucOccupantId?: string;
  delayed?: {
    stamp: string;
    from?: string;
  };
  rawNamespaces?: string[];
}

export interface DeliveryMeta {
  receivedAt: string;
  gatewayId: string;
  deliveryId: string;
  redelivered?: boolean;
}

export interface InboundMessage {
  type: 'inbound.message';
  message: AgentMessage;
  delivery: DeliveryMeta;
  xmpp?: XmppSourceMetadata;
}

export interface InboundEvent {
  type: 'inbound.event';
  event: Record<string, unknown>;
  delivery: DeliveryMeta;
}

export interface InboundCommand {
  type: 'inbound.command';
  command: string;
  args?: Record<string, unknown>;
  delivery: DeliveryMeta;
}

export interface InboundLifecycleEvent {
  type: 'inbound.lifecycle';
  lifecycle: Record<string, unknown>;
  delivery: DeliveryMeta;
}

export type InboundEnvelope =
  | InboundMessage
  | InboundEvent
  | InboundCommand
  | InboundLifecycleEvent;

/** ask_user_question payload — shared between host delivery and XMPP form rendering. */
export interface AskQuestionOption {
  label: string;
  selectedLabel?: string;
  value?: string;
}

export type AskQuestionOptionInput = string | AskQuestionOption;

export interface AskQuestionPayload {
  type: 'ask_question';
  questionId: string;
  title: string;
  question: string;
  options: AskQuestionOptionInput[];
}

/** Bridge webhook payload: routing + normalized message for NanoClaw. */
export interface BridgeInboundPayload {
  platformId: string;
  threadId: string | null;
  message: {
    id: string;
    kind: 'chat';
    content: unknown;
    timestamp: string;
    isMention?: boolean;
    isGroup?: boolean;
  };
  agentJid: string;
  envelope: InboundMessage;
}

/** XEP-0004 form submit for ask_user_question — routed to host onAction, not the agent. */
export interface BridgeFormResponsePayload {
  type: 'form_response';
  agentJid: string;
  platformId: string;
  threadId: string | null;
  questionId: string;
  selectedIndex: number;
  userId: string;
  timestamp: string;
}

export type BridgeWebhookPayload = BridgeInboundPayload | BridgeFormResponsePayload;

export function isBridgeFormResponsePayload(payload: BridgeWebhookPayload): payload is BridgeFormResponsePayload {
  return 'type' in payload && payload.type === 'form_response';
}

/** Gateway outbound deliver request from NanoClaw bridge. */
export interface OutboundDeliverRequest {
  from: string;
  to: string;
  threadId?: string | null;
  content: unknown;
  inReplyTo?: string;
  files?: Array<{ filename: string; dataBase64: string; mediaType?: string }>;
}

export interface OutboundDeliverResponse {
  messageId: string;
}
