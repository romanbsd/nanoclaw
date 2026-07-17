# Agent XMPP Adapter API Surface

Version: 0.1
Status: Draft
Purpose: Define the thin API layer that lets LLM agents communicate over XMPP without requiring agents to understand XMPP stanzas, XEP-specific XML, or server internals.

---

## 1. Design Summary

The bridge should be implemented as:

```text
XMPP Server
  ↕
Agent XMPP Gateway
  ├─ inbound delivery: HTTP or stdin JSONL into the agent runner
  └─ outbound tools: MCP server exposing XMPP capabilities
        ↕
Agent Host / LLM Runtime
```

The agent does **not** speak XMPP directly.

The agent receives incoming XMPP messages as normalized JSON events, and sends replies or outbound actions by calling MCP tools.

This creates a thin, stable contract:

```text
Inbound:
  XMPP → Gateway → AgentMessage JSON → Agent Runner

Outbound:
  Agent → MCP tool call → Gateway → XMPP
```

---

## 2. Packaging Recommendation

Package three components:

```text
agent-xmpp-gateway
  XMPP component / client.
  Owns routing, JID mapping, XEP plugins, wake/sleep, policy, archive, PubSub.

agent-xmpp-mcp
  MCP server exposing outbound XMPP actions as tools.

agent-runner
  HTTP or stdio listener that receives inbound messages and starts/resumes the agent run.
```

### Why MCP is not enough by itself

MCP is excellent for actions the agent chooses to invoke:

- send message
- reply
- upload file
- publish event
- query archive
- discover agents

But incoming XMPP messages are external events. They are not tools. They should be delivered through an inbound event channel that starts or resumes an agent run.

---

## 3. Core Concepts

| Concept | XMPP Mapping |
|---|---|
| Logical agent | Bare JID, e.g. `planner@agents.example` |
| Running agent instance | Full JID resource, e.g. `planner@agents.example/container-7f3a` |
| Human-agent conversation | XMPP message or MUC room |
| Task / workflow | `threadId` and stable stanza IDs |
| Agent event | PubSub item |
| Artifact | HTTP upload / stateless file share |
| Memory / transcript | MAM archive |
| Agent capabilities | Service Discovery / Entity Capabilities |
| Gateway | XMPP component / namespace delegate |

---

## 4. Agent API Surface

Agents should see capabilities, not XEPs.

### 4.1 Inbound Runtime API

The agent runner must support one or both of these transports.

#### HTTP ingress

```http
POST /v1/inbox
Content-Type: application/json
```

Request body:

```ts
type InboundEnvelope =
  | InboundMessage
  | InboundEvent
  | InboundCommand
  | InboundLifecycleEvent;
```

#### Stdio ingress

Each line is a JSON object.

```jsonl
{"type":"inbound.message","message":{...}}
{"type":"inbound.event","event":{...}}
```

Use stdio JSONL for simple spawned containers. Use HTTP for long-running agent runtimes.

---

## 5. Inbound Message Format

### 5.1 `InboundMessage`

```ts
type InboundMessage = {
  type: "inbound.message";

  message: AgentMessage;

  delivery: {
    receivedAt: string;          // ISO-8601
    gatewayId: string;
    deliveryId: string;          // gateway-local delivery attempt ID
    redelivered?: boolean;
  };

  xmpp?: XmppSourceMetadata;
};
```

### 5.2 `AgentMessage`

```ts
type AgentMessage = {
  id: string;                    // stable message/stanza ID
  from: string;                  // JID or external identity
  to: string;                    // target agent JID
  threadId?: string;             // task/conversation/workflow ID
  roomId?: string;               // MUC room JID, if applicable

  kind:
    | "text"
    | "task"
    | "result"
    | "error"
    | "file"
    | "command"
    | "event";

  contentType: string;           // text/plain, application/json, etc.
  body: unknown;                 // string for text, object for structured content

  replyTo?: string;              // parent message ID
  attachments?: FileRef[];

  trace?: TraceContext;
  policy?: MessagePolicy;

  extensions?: Record<string, unknown>;
};
```

### 5.3 `TraceContext`

```ts
type TraceContext = {
  tenantId?: string;
  workflowId?: string;
  runId?: string;
  spanId?: string;
  correlationId?: string;
};
```

### 5.4 `MessagePolicy`

```ts
type MessagePolicy = {
  store?: boolean;               // should this be archived?
  ttlSeconds?: number | null;    // expiration request
  trainingAllowed?: boolean;
  containsPii?: boolean;
  sensitivity?: "public" | "internal" | "confidential" | "secret";
};
```

### 5.5 `FileRef`

```ts
type FileRef = {
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
};
```

### 5.6 `XmppSourceMetadata`

This is optional and mostly for debugging/audit. Agents should not depend on it.

```ts
type XmppSourceMetadata = {
  stanzaId?: string;
  stableId?: string;
  stanzaType?: "chat" | "groupchat" | "normal" | "headline" | "error";
  fromResource?: string;
  toResource?: string;
  mucOccupantId?: string;
  delayed?: {
    stamp: string;
    from?: string;
  };
  rawNamespaces?: string[];
};
```

---

## 6. Inbound Examples

### 6.1 Human text message

```json
{
  "type": "inbound.message",
  "message": {
    "id": "msg_01JZ9X2P3ABCD",
    "from": "roman@example.com",
    "to": "planner@agents.example",
    "threadId": "thread_01JZ9X",
    "kind": "text",
    "contentType": "text/plain",
    "body": "Ask the researcher agent to summarize XEP-0432."
  },
  "delivery": {
    "receivedAt": "2026-07-03T20:10:00Z",
    "gatewayId": "gw-1",
    "deliveryId": "del_01JZ9X2P3"
  },
  "xmpp": {
    "stanzaType": "chat",
    "stableId": "msg_01JZ9X2P3ABCD"
  }
}
```

### 6.2 Structured task message

```json
{
  "type": "inbound.message",
  "message": {
    "id": "msg_01JZ9Y6K",
    "from": "planner@agents.example",
    "to": "researcher@agents.example",
    "threadId": "task_01JZ9Y",
    "kind": "task",
    "contentType": "application/vnd.solstice.agent-task+json",
    "body": {
      "task": "Summarize XEP-0363 and explain how file upload should map to agent artifacts.",
      "depth": "architecture",
      "maxWords": 800
    },
    "trace": {
      "tenantId": "acme",
      "workflowId": "wf_123",
      "correlationId": "corr_456"
    },
    "policy": {
      "store": true,
      "trainingAllowed": false,
      "sensitivity": "internal"
    }
  },
  "delivery": {
    "receivedAt": "2026-07-03T20:15:00Z",
    "gatewayId": "gw-1",
    "deliveryId": "del_01JZ9Y6K"
  }
}
```

### 6.3 MUC room message

```json
{
  "type": "inbound.message",
  "message": {
    "id": "msg_room_123",
    "from": "strategy-room@conference.example/roman",
    "to": "planner@agents.example",
    "roomId": "strategy-room@conference.example",
    "threadId": "room-thread-77",
    "kind": "text",
    "contentType": "text/plain",
    "body": "@planner create an action plan from the discussion so far."
  },
  "delivery": {
    "receivedAt": "2026-07-03T20:20:00Z",
    "gatewayId": "gw-1",
    "deliveryId": "del_room_123"
  },
  "xmpp": {
    "stanzaType": "groupchat",
    "mucOccupantId": "occupant_abc"
  }
}
```

### 6.4 Inbound file message

```json
{
  "type": "inbound.message",
  "message": {
    "id": "msg_file_123",
    "from": "roman@example.com",
    "to": "analyst@agents.example",
    "threadId": "case_456",
    "kind": "file",
    "contentType": "application/vnd.solstice.file-message+json",
    "body": {
      "note": "Please analyze this report."
    },
    "attachments": [
      {
        "name": "report.pdf",
        "url": "https://upload.example/files/report.pdf",
        "mediaType": "application/pdf",
        "sizeBytes": 2459912,
        "sha256": "..."
      }
    ]
  },
  "delivery": {
    "receivedAt": "2026-07-03T20:25:00Z",
    "gatewayId": "gw-1",
    "deliveryId": "del_file_123"
  }
}
```

---

## 7. Outbound MCP Tool Surface

The agent calls XMPP through MCP tools.

### 7.1 `xmpp.reply`

Reply to an inbound message.

```ts
type XmppReplyInput = {
  inReplyTo: string;             // inbound message ID
  threadId?: string;
  kind?: "text" | "task" | "result" | "error" | "file";
  contentType?: string;
  body: unknown;
  attachments?: FileRef[];
  policy?: MessagePolicy;
};
```

Example:

```json
{
  "inReplyTo": "msg_01JZ9X2P3ABCD",
  "body": "I asked researcher@agents.example to summarize XEP-0432.",
  "contentType": "text/plain"
}
```

### 7.2 `xmpp.send_message`

Send a direct message to a JID.

```ts
type XmppSendMessageInput = {
  to: string;
  threadId?: string;
  kind: "text" | "task" | "result" | "error" | "file" | "command";
  contentType: string;
  body: unknown;
  attachments?: FileRef[];
  replyTo?: string;
  trace?: TraceContext;
  policy?: MessagePolicy;
};
```

### 7.3 `xmpp.publish_event`

Publish an event to a PubSub node.

```ts
type XmppPublishEventInput = {
  node: string;
  eventType: string;
  id?: string;
  body: unknown;
  contentType?: string;
  trace?: TraceContext;
  policy?: MessagePolicy;
};
```

### 7.4 `xmpp.upload_file`

Upload a file and return a `FileRef`.

```ts
type XmppUploadFileInput = {
  path?: string;                 // local path if available to runtime
  bytesBase64?: string;          // fallback for small files only
  name: string;
  mediaType: string;
  description?: string;
  metadata?: Record<string, unknown>;
};
```

Output:

```ts
type XmppUploadFileOutput = {
  file: FileRef;
};
```

### 7.5 `xmpp.share_file`

Send an existing file reference to a recipient or room.

```ts
type XmppShareFileInput = {
  to: string;
  threadId?: string;
  file: FileRef;
  note?: string;
  policy?: MessagePolicy;
};
```

### 7.6 `xmpp.join_room`

```ts
type XmppJoinRoomInput = {
  roomJid: string;
  nickname?: string;
  password?: string;
};
```

### 7.7 `xmpp.leave_room`

```ts
type XmppLeaveRoomInput = {
  roomJid: string;
  reason?: string;
};
```

### 7.8 `xmpp.send_room_message`

```ts
type XmppSendRoomMessageInput = {
  roomJid: string;
  threadId?: string;
  body: unknown;
  contentType?: string;
  mentions?: string[];
  attachments?: FileRef[];
};
```

### 7.9 `xmpp.discover_agents`

```ts
type XmppDiscoverAgentsInput = {
  query?: string;
  capabilities?: string[];
  tenantId?: string;
  includeUnavailable?: boolean;
};
```

Output:

```ts
type AgentDescriptor = {
  jid: string;
  name?: string;
  description?: string;
  capabilities: string[];
  status?: "available" | "busy" | "offline" | "dormant";
  metadata?: Record<string, unknown>;
};
```

### 7.10 `xmpp.get_archive`

```ts
type XmppGetArchiveInput = {
  with?: string;                 // JID
  roomId?: string;
  threadId?: string;
  query?: string;
  start?: string;
  end?: string;
  limit?: number;
  before?: string;
  after?: string;
};
```

Output:

```ts
type XmppGetArchiveOutput = {
  messages: AgentMessage[];
  paging?: {
    before?: string;
    after?: string;
    complete?: boolean;
  };
};
```

### 7.11 `xmpp.set_presence`

```ts
type XmppSetPresenceInput = {
  status: "available" | "away" | "busy" | "offline" | "dormant";
  message?: string;
  capabilities?: string[];
};
```

### 7.12 `xmpp.ack`

Acknowledge message processing.

```ts
type XmppAckInput = {
  messageId: string;
  status: "received" | "seen" | "processing" | "completed" | "failed";
  error?: {
    code: string;
    message: string;
    retryable?: boolean;
  };
};
```

### 7.13 `xmpp.run_command`

Administrative or lifecycle command via the gateway.

```ts
type XmppRunCommandInput = {
  target: string;
  command: string;
  args?: Record<string, unknown>;
};
```

Examples:

- inspect agent
- drain queue
- restart
- pause
- resume
- refresh capabilities

---

## 8. Agent System Prompt Contract

The agent host should inject instructions similar to:

```text
You are connected to the XMPP agent backbone.

Use xmpp.reply when replying to the sender of the current inbound message.
Use xmpp.send_message when contacting another user or agent.
Use xmpp.discover_agents before addressing an agent whose JID you do not know.
Use xmpp.upload_file before sending large generated artifacts.
Use xmpp.publish_event for durable workflow, memory, status, or telemetry events.
Use xmpp.get_archive only when conversation history is needed.
Do not invent JIDs.
Do not expose raw XMPP stanzas to users.
```

---

## 9. Required XEPs

### 9.1 Minimum viable bridge

| XEP | Name | Why it matters |
|---|---|---|
| XEP-0114 | Jabber Component Protocol | Lets the gateway act as an XMPP component that owns `agents.example` and routes many virtual agent JIDs. |
| XEP-0030 | Service Discovery | Discover agents, gateway features, upload services, PubSub services, and rooms. |
| XEP-0432-inspired | Simple JSON Messaging | Use JSON payloads in messages. Treat as inspiration/convention if server/client support is incomplete. |
| XEP-0359 | Stable and Unique Stanza IDs | Idempotency, durable message IDs, traceability, deduplication. |
| XEP-0198 | Stream Management | Reliable delivery and stream resumption for gateway/server links. |
| XEP-0313 | Message Archive Management | Durable message archive / memory source. |
| XEP-0060 | Publish-Subscribe | Event bus for workflow events, agent state, memory signals, telemetry. |
| XEP-0045 | Multi-User Chat | Human-agent workspaces and multi-agent collaboration rooms. |

### 9.2 Strongly recommended

| XEP | Name | Why it matters |
|---|---|---|
| XEP-0355 | Namespace Delegation | Lets the server delegate custom namespaces to the gateway. Useful for clean agent-specific stanza handling. |
| XEP-0100 | Gateway Interaction | Conceptual model for XMPP users interacting with a gateway to another system. |
| XEP-0131 | Stanza Headers and Internet Metadata | Trace IDs, tenant IDs, priority, policy hints. |
| XEP-0334 | Message Processing Hints | `store`, `no-store`, `no-copy` style memory/privacy hints. |
| XEP-0461 | Message Replies | Parent-child reply graph for task trees and tool-call conversations. |
| XEP-0481 | Content Types in Messages | Explicitly identify text, JSON task, result, file reference, etc. |
| XEP-0184 | Message Delivery Receipts | Delivery acknowledgment. |
| XEP-0333 | Chat Markers | Seen / displayed / acknowledged state. |
| XEP-0059 | Result Set Management | Pagination for archives, search results, PubSub items. |
| XEP-0050 | Ad-Hoc Commands | Admin/control-plane commands. |

### 9.3 File and artifact support

| XEP | Name | Why it matters |
|---|---|---|
| XEP-0363 | HTTP File Upload | Upload artifacts and receive shareable URLs. |
| XEP-0446 | File Metadata Element | Name, media type, size, hashes, thumbnails, descriptions. |
| XEP-0447 | Stateless File Sharing | Send files as references, not as in-band blobs. |
| XEP-0300 | Use of Cryptographic Hash Functions | Integrity verification and deduplication. |
| XEP-0066 | Out of Band Data | Simple fallback for sharing URLs. |

### 9.4 Security, policy, and operations

| XEP | Name | Why it matters |
|---|---|---|
| XEP-0191 | Blocking Command | Abuse/safety controls. |
| XEP-0258 | Security Labels in XMPP | Confidentiality labels for sensitive messages. |
| XEP-0504 | Data Policy | Retention, privacy, training/no-training metadata. |
| XEP-0455 | Service Outage Status | Publish gateway/agent outage status. |
| XEP-0478 | Stream Limits Advertisement | Backpressure and server limits. |
| XEP-0475 | PubSub Signing | Signed auditable agent events. |
| XEP-0477 | PubSub Targeted Encryption | Confidential PubSub events. |
| XEP-0384 | OMEMO Encryption | End-to-end encryption where needed. |
| XEP-0420 | Stanza Content Encryption | Modern stanza encryption model. |

### 9.5 Later / optional

| XEP | Name | Possible use |
|---|---|---|
| XEP-0115 | Entity Capabilities | Compact cached capability advertisement. |
| XEP-0163 | Personal Eventing Protocol | Per-agent profile/state events. |
| XEP-0223 | Persistent Storage of Private Data via PubSub | Agent state/config storage. |
| XEP-0248 | PubSub Collection Nodes | Tenant/project event tree organization. |
| XEP-0280 | Message Carbons | Multi-device human consoles. |
| XEP-0369 | MIX | Future room/channel alternative to MUC. |
| XEP-0410 | MUC Self-Ping | Detect lost room presence. |
| XEP-0431 | Full Text Search in MAM | Search archive; could be backed by OpenSearch. |
| XEP-0441 | MAM Preferences | Per-agent memory retention preferences. |
| XEP-0442 | PubSub Message Archive Management | Archive event bus items. |
| XEP-0451 | Stanza Multiplexing | Many logical streams over one connection. |
| XEP-0500 | MUC Slow Mode | Rate-limiting noisy agent rooms. |
| XEP-0503 | Server-side Spaces | BusinessOS workspace/project grouping. |
| XEP-0511 | Link Metadata | Rich link previews and artifact metadata. |
| XEP-0513 | Explicit Mentions | Structured human/agent mentions. |

---

## 10. XEP-to-API Mapping

| Agent capability | Primary XEPs |
|---|---|
| Receive direct message | Core XMPP message, XEP-0432-inspired JSON, XEP-0359 |
| Reply | XEP-0461, `<thread>`, XEP-0359 |
| Send structured task | Core message, XEP-0481, XEP-0432-inspired JSON |
| Publish event | XEP-0060 |
| Subscribe to events | XEP-0060 |
| Upload file | XEP-0363 |
| Share file | XEP-0446, XEP-0447, XEP-0066 fallback |
| Join room | XEP-0045 |
| Send room message | XEP-0045, XEP-0513 |
| Discover agents | XEP-0030, XEP-0115 |
| Query archive | XEP-0313, XEP-0059 |
| Acknowledge delivery | XEP-0184, XEP-0333 |
| Memory/store policy | XEP-0334, XEP-0504 |
| Gateway component | XEP-0114 |
| Gateway namespace handling | XEP-0355 |
| Gateway interaction model | XEP-0100 |
| Admin command | XEP-0050 |

---

## 11. Minimal XMPP Message Encoding

A structured task should be encoded as an ordinary XMPP message with human-readable fallback text plus machine-readable JSON.

```xml
<message
    from="planner@agents.example"
    to="researcher@agents.example"
    type="chat"
    id="msg_01JZ9Y6K">

  <thread>task_01JZ9Y</thread>

  <body>Task: Summarize XEP-0363 and explain artifact upload.</body>

  <payload xmlns="urn:xmpp:json-msg:0"
           datatype="application/vnd.solstice.agent-task+json">
    {
      "kind": "task",
      "contentType": "application/vnd.solstice.agent-task+json",
      "body": {
        "task": "Summarize XEP-0363 and explain artifact upload.",
        "depth": "architecture"
      },
      "trace": {
        "tenantId": "acme",
        "workflowId": "wf_123"
      },
      "policy": {
        "store": true,
        "trainingAllowed": false
      }
    }
  </payload>
</message>
```

Notes:

- `<body>` is required as human fallback.
- JSON payload is the agent-native representation.
- The gateway should preserve unknown XMPP extensions in `extensions` when useful.
- The agent should not depend on raw XMPP XML.

---

## 12. Delivery Semantics

### 12.1 Idempotency

Agents must treat `message.id` as idempotency key.

If the same inbound message is delivered twice, the agent should avoid duplicate side effects.

### 12.2 Acknowledgment

The runner should acknowledge receipt to the gateway immediately at transport level, then the agent should use `xmpp.ack` for semantic progress:

```text
received   - delivered to runtime
seen       - agent run started
processing - task accepted
completed  - task completed
failed     - task failed
```

### 12.3 Redelivery

The gateway may redeliver messages if:

- the container failed before acknowledging receipt
- the agent did not complete within timeout
- the gateway restarted
- XMPP stream resumed with uncertain delivery state

### 12.4 Ordering

Ordering is guaranteed only within a single sender/recipient/thread where the gateway can preserve order.

Agents should not assume global ordering.

---

## 13. Wake/Sleep Lifecycle

```text
1. XMPP stanza arrives for agent bare JID.
2. Gateway checks if an active resource/container exists.
3. If no active container exists, gateway starts one.
4. Gateway waits for runner readiness.
5. Gateway delivers InboundMessage over HTTP or stdin.
6. Agent performs work.
7. Agent calls MCP tools for replies/outbound actions.
8. Gateway tracks activity and shuts container down after idle timeout.
```

The agent should not need to know whether it was cold-started or already running.

---

## 14. Implementation Notes

### 14.1 Do not expose raw XEPs to agents

Avoid:

```ts
sendXep0363SlotRequest(...)
sendXep0060Publish(...)
```

Prefer:

```ts
uploadFile(...)
publishEvent(...)
```

XEPs are implementation details behind capability plugins.

### 14.2 Manual XEP plugins, not XSD-to-JSON generation

Do not try to convert all XEP XML schemas into JSON schemas.

Reason:

- many XEPs define workflows, not just XML shapes
- file upload requires discovery, slot request, HTTP PUT, then sharing
- PubSub requires node semantics and subscription behavior
- MUC requires presence, nicknames, affiliation/role semantics

Use manual semantic plugins for selected XEP families.

### 14.3 Preserve extensibility

Unknown XMPP namespaces may be stored in:

```ts
extensions?: Record<string, unknown>;
```

But agents should only rely on normalized fields.

---

## 15. MVP Checklist

Implement first:

- XEP-0114 gateway component
- direct message normalization
- HTTP or stdin inbound delivery
- MCP tools:
  - `xmpp.reply`
  - `xmpp.send_message`
  - `xmpp.discover_agents`
  - `xmpp.upload_file`
  - `xmpp.publish_event`
  - `xmpp.get_archive`
- message IDs and idempotency
- basic MAM archive integration
- basic PubSub event publishing
- file upload via XEP-0363
- MUC support for human-agent rooms

Defer:

- full encryption
- PubSub signing
- server-side spaces
- complex moderation
- full-text search
- MIX
- schema generation
- automatic handling of arbitrary XEPs

---

## 16. Recommended Directory Layout

```text
agent-xmpp/
  packages/
    gateway/
      src/
        xmpp-component.ts
        stanza-router.ts
        lifecycle-manager.ts
        xep-plugins/
          message.ts
          discovery.ts
          pubsub.ts
          muc.ts
          mam.ts
          file-upload.ts
          commands.ts

    mcp/
      src/
        server.ts
        tools/
          reply.ts
          send-message.ts
          publish-event.ts
          upload-file.ts
          discover-agents.ts
          get-archive.ts

    runner/
      src/
        http-inbox.ts
        stdio-inbox.ts
        agent-host.ts

    schemas/
      src/
        agent-message.ts
        file-ref.ts
        trace-context.ts
        policy.ts
```

---

## 17. Core Recommendation

Use:

```text
MCP for outbound actions.
HTTP/stdin JSONL for inbound event injection.
XMPP as the durable routing, identity, room, event, archive, and federation substrate.
```

This is the thinnest practical bridge that keeps agents simple while preserving the power of XMPP.
