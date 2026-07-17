# A2A over XMPP Protocol Binding

**Version:** 1.0 (draft)
**Status:** Draft
**A2A protocol version:** 1.0
**Binding identifier:** `urn:xmpp:a2a:binding:1.0`

This document defines a custom [Agent2Agent (A2A) protocol binding](https://a2a-protocol.org/) over XMPP. It maps A2A abstract operations (Layer 2) and the canonical data model (Layer 1) to XMPP stanzas, XEP extensions, and gateway semantics used by the NanoClaw `agent-xmpp` stack.

**Normative references:**

| Document                                                                      | Role                                             |
| ----------------------------------------------------------------------------- | ------------------------------------------------ |
| [A2A specification](https://a2a-protocol.org/latest/specification/)           | A2A operations and data model                    |
| [RFC 6120](https://www.rfc-editor.org/rfc/rfc6120)                            | XMPP Core                                        |
| [RFC 6121](https://www.rfc-editor.org/rfc/rfc6121)                            | XMPP Instant Messaging and Presence              |
| [docs/agent-xmpp-adapter-api-surface.md](./agent-xmpp-adapter-api-surface.md) | Gateway ↔ agent-runner contract (non-A2A agents) |
| [docs/xmpp-agent-gateway-solution.md](./xmpp-agent-gateway-solution.md)       | Implemented gateway architecture                 |

---

## 1. Design Summary

A2A over XMPP treats **each remote agent as a bare JID** on an agent domain (e.g. `researcher@agents.example`). Clients never construct raw A2A HTTP endpoints; they address agents by JID and exchange A2A-shaped JSON over XMPP.

```text
A2A Client                    XMPP Server                 Agent Gateway              Agent Runtime
    │                              │                            │                         │
    │  SendMessage (chat + JSON)   │                            │                         │
    ├─────────────────────────────►│───────────────────────────►│  normalize + wake       │
    │                              │                            ├────────────────────────►│
    │                              │                            │                         │
    │  Task / Message reply        │                            │◄────────────────────────┤
    │◄─────────────────────────────┤◄───────────────────────────┤                         │
    │                              │                            │                         │
    │  GetTask / Subscribe (IQ)    │                            │                         │
    ├─────────────────────────────►│───────────────────────────►│                         │
    │                              │                            │                         │
    │  Task updates (PubSub)       │                            │                         │
    │◄─────────────────────────────┤◄───────────────────────────┤                         │
```

**Architectural split (same as XEP-0100 gateway model):**

| Layer                | Responsibility                                                             |
| -------------------- | -------------------------------------------------------------------------- |
| XMPP server          | Routing, MAM, PubSub service, MUC, SASL                                    |
| `agent-xmpp-gateway` | XEP translation, mailbox, wake policy, A2A IQ handling, Agent Card hosting |
| Agent runtime        | A2A semantics only — never parses XMPP XML                                 |

Agents that speak A2A natively MAY run inside a container and receive normalized events via the existing Agent XMPP Adapter API Surface. The gateway performs A2A ↔ adapter translation when configured for A2A mode.

---

## 2. Binding Identification

Per A2A §5.8, declare this binding in the Agent Card `supportedInterfaces`:

```json
{
  "supportedInterfaces": [
    {
      "url": "xmpp:researcher@agents.example",
      "protocolBinding": "urn:xmpp:a2a:binding:1.0",
      "protocolVersion": "1.0",
      "tenant": "acme"
    }
  ]
}
```

| Field             | XMPP semantics                                                                                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `url`             | `xmpp:{bare-jid}` URI ([RFC 5122](https://www.rfc-editor.org/rfc/rfc5122)). The gateway component owns the agent domain; individual agent JIDs are virtual addresses routed by the gateway (XEP-0114). |
| `protocolBinding` | `urn:xmpp:a2a:binding:1.0`                                                                                                                                                                             |
| `protocolVersion` | A2A major.minor (e.g. `1.0`)                                                                                                                                                                           |
| `tenant`          | Opaque routing label; gateway maps to internal tenant scope. Transmitted as an A2A service parameter (§7).                                                                                             |

When an agent also exposes HTTP bindings, list both interfaces; clients choose per A2A §5.2.

---

## 3. Core Concept Mapping

| A2A concept               | XMPP identity / carrier                                         | Primary XEPs                           |
| ------------------------- | --------------------------------------------------------------- | -------------------------------------- |
| A2A Server (remote agent) | Bare JID `agent@agents.example`                                 | Core, XEP-0114                         |
| A2A Client                | Any authenticated XMPP entity (human JID or agent JID)          | Core                                   |
| Agent Card                | PEP node + disco#info features                                  | XEP-0163, XEP-0030                     |
| Message                   | `<message type="chat\|groupchat\|normal">`                      | Core, XEP-0432-inspired JSON, XEP-0481 |
| Task                      | IQ-managed resource + PubSub event stream                       | Custom IQ (`urn:xmpp:a2a:0`), XEP-0060 |
| Context                   | `<thread>` element                                              | Core (RFC 6121)                        |
| Part (text/file/data)     | JSON payload + file refs                                        | XEP-0432-inspired, XEP-0363, XEP-0447  |
| Artifact                  | PubSub item or file reference in task reply                     | XEP-0060, XEP-0446                     |
| Streaming                 | PubSub subscription on task node                                | XEP-0060, XEP-0313 (history)           |
| Push notifications        | HTTP webhook (A2A-native); gateway bridges from internal events | A2A §4.3 (HTTP POST unchanged)         |
| Discovery                 | Service Discovery + Agent Card fetch                            | XEP-0030, XEP-0115, XEP-0163           |
| Idempotency key           | Stanza `@id` + `<origin-id>`                                    | XEP-0359                               |
| Reply graph               | `<reply id="…">`                                                | XEP-0461                               |
| Archive / history         | MAM query filtered by JID + thread                              | XEP-0313, XEP-0059                     |
| Multi-agent room          | MUC room JID                                                    | XEP-0045                               |
| Gateway                   | XEP-0114 component + XEP-0100 interaction model                 | XEP-0114, XEP-0100                     |

---

## 4. Namespaces and Media Types

### 4.1 XMPP namespaces

| Namespace                  | Purpose                                                                      |
| -------------------------- | ---------------------------------------------------------------------------- |
| `urn:xmpp:a2a:0`           | A2A IQ payloads (GetTask, ListTasks, CancelTask, push config, extended card) |
| `urn:xmpp:a2a:agentcard:0` | Agent Card JSON in PEP / PubSub items                                        |
| `urn:xmpp:a2a:task:0`      | Task state snapshots and stream events in PubSub                             |
| `urn:xmpp:json-msg:0`      | Machine-readable message body (XEP-0432-inspired convention)                 |
| `urn:xmpp:content-type:0`  | Explicit MIME type on messages (XEP-0481-inspired)                           |
| `urn:xmpp:reply:0`         | Parent message reference (XEP-0461)                                          |
| `urn:xmpp:sid:0`           | Stable stanza IDs (XEP-0359)                                                 |
| `urn:xmpp:hints`           | Store / no-store policy (XEP-0334)                                           |
| `urn:xmpp:agent-event:0`   | Generic agent events on PubSub (existing gateway convention)                 |

### 4.2 Media types

| Usage                                  | Media type                                            |
| -------------------------------------- | ----------------------------------------------------- |
| A2A Message / Task JSON in `<payload>` | `application/vnd.a2a+json`                            |
| A2A StreamResponse on PubSub           | `application/vnd.a2a+json`                            |
| Agent Card                             | `application/vnd.a2a.agentcard+json`                  |
| Human-readable fallback in `<body>`    | `text/plain` (required alongside structured payloads) |

JSON field naming follows A2A §5.5 (**camelCase**, ProtoJSON enum strings).

---

## 5. Data Model Mapping

All A2A objects from the [A2A data model](https://a2a-protocol.org/latest/specification/#4-data-model) MUST round-trip through the representations below.

### 5.1 Message → XMPP `<message>`

An A2A `Message` is encoded as an XMPP message stanza:

```xml
<message from="client@example.com"
         to="researcher@agents.example"
         type="chat"
         id="msg-uuid">
  <thread>ctx-uuid</thread>
  <body>Summarize XEP-0363 for me.</body>
  <reply xmlns="urn:xmpp:reply:0" id="parent-msg-id"/>
  <origin-id xmlns="urn:xmpp:sid:0" id="msg-uuid"/>
  <content-type xmlns="urn:xmpp:content-type:0" type="application/vnd.a2a+json"/>
  <payload xmlns="urn:xmpp:json-msg:0" datatype="application/vnd.a2a+json">
  {
    "a2a": {
      "messageId": "msg-uuid",
      "contextId": "ctx-uuid",
      "taskId": "task-uuid",
      "role": "ROLE_USER",
      "parts": [
        { "text": "Summarize XEP-0363 for me.", "mediaType": "text/plain" }
      ],
      "metadata": {},
      "extensions": [],
      "referenceTaskIds": []
    }
  }
  </payload>
  <store xmlns="urn:xmpp:hints"/>
</message>
```

| A2A field          | XMPP location                                                                                                  |
| ------------------ | -------------------------------------------------------------------------------------------------------------- |
| `messageId`        | `@id` on `<message>`; SHOULD also appear in `<origin-id id="…">` (XEP-0359)                                    |
| `contextId`        | `<thread>text</thread>`                                                                                        |
| `taskId`           | `a2a.taskId` in JSON payload; when continuing a task, MUST be present                                          |
| `role`             | `a2a.role` in JSON payload                                                                                     |
| `parts[]`          | `a2a.parts` in JSON payload                                                                                    |
| `metadata`         | `a2a.metadata` in JSON payload                                                                                 |
| `extensions`       | `a2a.extensions` (URI strings) + optional `<headers xmlns="urn:xmpp:eme:0">` for transport metadata (XEP-0131) |
| `referenceTaskIds` | `a2a.referenceTaskIds` in JSON payload                                                                         |

**MUC:** When `contextId` spans a shared room, set `type="groupchat"`, `from="room@conference.example/nick"`, and include `roomId` in the JSON envelope (`a2a.roomId`).

### 5.2 Part → JSON + file XEPs

| Part field | Representation                                                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `text`     | JSON `{ "text": "…", "mediaType": "text/plain" }`                                                                                    |
| `data`     | JSON `{ "data": {…}, "mediaType": "application/json" }`                                                                              |
| `url`      | JSON `{ "url": "https://…", "mediaType": "…", "filename": "…" }` plus optional `<x xmlns="jabber:x:oob"><url>…</url></x>` (XEP-0066) |
| `raw`      | Base64 in JSON `{ "raw": "…", "mediaType": "…" }` for small payloads; large binaries MUST use XEP-0363 upload → `url` part           |

Uploaded files use XEP-0363 (HTTP upload slot) and XEP-0446 metadata / XEP-0447 stateless sharing, surfaced to A2A as `Part.url` with `mediaType`, `filename`, and optional `sha256` (XEP-0300).

### 5.3 Task → IQ + PubSub

A `Task` is a server-managed resource keyed by `taskId`.

**Storage:**

- Authoritative task state lives in the gateway (or agent backend reachable by the gateway).
- Latest snapshot is published to PubSub node `urn:xmpp:a2a:task:{taskId}` on `pubsub.{agentDomain}`.
- Message history for the task is archived via MAM with `thread` = `contextId` and metadata linking `taskId`.

**Task JSON (in IQ result or PubSub item):**

```json
{
  "id": "task-uuid",
  "contextId": "ctx-uuid",
  "status": {
    "state": "TASK_STATE_WORKING",
    "message": { "messageId": "…", "role": "ROLE_AGENT", "parts": […] },
    "timestamp": "2026-07-04T19:00:00.000Z"
  },
  "artifacts": [],
  "history": [],
  "metadata": {}
}
```

### 5.4 Artifact → PubSub item or Message attachment

| Delivery path   | XMPP mechanism                                                                    |
| --------------- | --------------------------------------------------------------------------------- |
| Inline result   | A2A `Message` / `Task` reply stanza (§5.1) with `artifacts[]` in JSON             |
| Streaming chunk | PubSub item on task node, typed as `TaskArtifactUpdateEvent`                      |
| Large artifact  | XEP-0363 URL in `Part.url`; gateway emits `TaskArtifactUpdateEvent` with URL part |

### 5.5 AgentCard → PEP + disco

**Primary publication:** PEP node `urn:xmpp:a2a:agentcard:0` on the agent bare JID (XEP-0163).

**Secondary discovery:**

- Gateway disco#info advertises feature var `urn:xmpp:a2a:binding:1.0`.
- disco#items on the agent domain lists available agent JIDs.
- Per-agent disco#info identity: `category="automation"`, `type="bot"`, `name="{AgentCard.name}"`.

The PubSub item payload is the Agent Card JSON document (camelCase, `application/vnd.a2a.agentcard+json`).

**Extended Agent Card:** Returned only via authenticated IQ `GetExtendedAgentCard` (§6.11); MUST NOT be published on the public PEP node.

### 5.6 StreamResponse → PubSub event

Each streaming event is one PubSub item on the task node (or a dedicated stream sub-node `urn:xmpp:a2a:task:{taskId}:stream`):

```json
{
  "task": { … }
}
```

or exactly one of: `message`, `statusUpdate`, `artifactUpdate` — matching the A2A `StreamResponse` model.

Items MUST be delivered in generation order (A2A §3.5.2). Subscribers SHOULD use PubSub item IDs for deduplication.

---

## 6. Operation Mapping

This table satisfies A2A §5.3 for the XMPP binding.

| A2A operation                        | XMPP transport   | Stanza / pattern                                                                                                                                         |
| ------------------------------------ | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SendMessage**                      | Message          | `<message type="chat">` with A2A JSON payload (§5.1). Response is either a reply `<message>` containing a `Message` or an IQ result containing a `Task`. |
| **SendStreamingMessage**             | Message + PubSub | Initial reply `<message>` with `Task`; subsequent events on `urn:xmpp:a2a:task:{taskId}:stream`. Requires `capabilities.streaming: true`.                |
| **GetTask**                          | IQ-get           | `<iq type="get"><query xmlns="urn:xmpp:a2a:0"><getTask id="…" historyLength="10"/></query></iq>`                                                         |
| **ListTasks**                        | IQ-get           | `<iq type="get"><query xmlns="urn:xmpp:a2a:0"><listTasks contextId="…" status="TASK_STATE_WORKING" pageSize="50" pageToken="…"/></query></iq>`           |
| **CancelTask**                       | IQ-set           | `<iq type="set"><query xmlns="urn:xmpp:a2a:0"><cancelTask id="…"/></query></iq>`                                                                         |
| **SubscribeToTask**                  | IQ-set + PubSub  | `<iq type="set"><query xmlns="urn:xmpp:a2a:0"><subscribeTask id="…"/></query></iq>` then PubSub subscription to task stream node (XEP-0060).             |
| **CreateTaskPushNotificationConfig** | IQ-set           | `<pushNotificationConfig taskId="…">…</pushNotificationConfig>` child of `urn:xmpp:a2a:0` query.                                                         |
| **GetTaskPushNotificationConfig**    | IQ-get           | `<getPushNotificationConfig taskId="…" configId="…"/>`                                                                                                   |
| **ListTaskPushNotificationConfigs**  | IQ-get           | `<listPushNotificationConfigs taskId="…" pageSize="…" pageToken="…"/>`                                                                                   |
| **DeleteTaskPushNotificationConfig** | IQ-set           | `<deletePushNotificationConfig taskId="…" configId="…"/>`                                                                                                |
| **GetExtendedAgentCard**             | IQ-get           | `<iq type="get"><query xmlns="urn:xmpp:a2a:0"><getExtendedAgentCard/></query></iq>` (SASL required)                                                      |

### 6.1 SendMessage flow

1. Client sends `<message>` to agent bare JID with A2A payload (`role: ROLE_USER`).
2. Gateway validates capabilities, extracts `messageId` for idempotency (§9).
3. Gateway wakes the agent runtime if needed (see [implemented gateway architecture](./xmpp-agent-gateway-solution.md)).
4. Agent processes request.
5. Agent returns either:
   - **Direct Message:** gateway sends `<message type="chat">` reply with `role: ROLE_AGENT`, or
   - **Task:** gateway sends `<message>` with embedded task reference **and** publishes full `Task` to PubSub; optionally returns synchronous IQ result if client requested blocking semantics via service parameter `a2a-return-immediately=false`.

`SendMessageConfiguration` fields map to service parameters and JSON metadata:

| A2A field                    | XMPP mapping                                                                        |
| ---------------------------- | ----------------------------------------------------------------------------------- |
| `acceptedOutputModes`        | `a2a-accepted-output-modes` service parameter (comma-separated MIME list)           |
| `historyLength`              | `historyLength` attribute on embedded `<getTask>` in blocking mode, or IQ follow-up |
| `returnImmediately`          | `a2a-return-immediately` service parameter (`true` / `false`)                       |
| `taskPushNotificationConfig` | Embedded in IQ-set before SendMessage, or included in message `a2a.metadata`        |

### 6.2 SendStreamingMessage flow

Requires `AgentCard.capabilities.streaming = true`.

1. Same initial `<message>` as SendMessage.
2. Gateway creates PubSub node `urn:xmpp:a2a:task:{taskId}:stream`.
3. Gateway sends reply `<message>` containing the initial `Task` or `Message`.
4. Agent emits `TaskStatusUpdateEvent` / `TaskArtifactUpdateEvent`; gateway publishes each as a PubSub item (§5.6).
5. Stream closes when task reaches terminal or interrupted state; gateway sends PubSub retraction or `<event xmlns="urn:xmpp:a2a:task:0" type="stream-end"/>` item.

If the agent returns a direct `Message` (no task), the stream MUST contain exactly one event and close (A2A §3.1.2).

### 6.3 SubscribeToTask flow

1. Client sends SubscribeToTask IQ.
2. Gateway ensures PubSub node exists and returns subscription id.
3. Client receives events via PubSub notifications (XEP-0060) or by polling PubSub items.
4. For offline clients, events remain on the node until TTL; clients MAY also use MAM for history.

### 6.4 Push notification bridge

A2A push notifications remain **HTTP POST webhooks** (A2A §3.5.1) regardless of binding. The XMPP gateway:

1. Accepts push config via A2A IQ (stores config server-side).
2. On task update, POSTs `StreamResponse` JSON to the registered URL.
3. MAY additionally publish a lightweight notification to a client PEP node for XMPP-native clients that prefer PubSub over HTTP.

This preserves A2A semantic equivalence while allowing XMPP-only clients to skip HTTP push and use PubSub streaming instead.

### 6.5 GetTask / ListTasks / CancelTask

All task management operations use **IQ stanzas** to the agent bare JID (routed to the gateway component).

**GetTask response:**

```xml
<iq type="result" from="researcher@agents.example" to="client@example.com" id="…">
  <query xmlns="urn:xmpp:a2a:0">
    <task>{ … Task JSON … }</task>
  </query>
</iq>
```

**ListTasks response:** `<tasks>` wrapper with repeated `<task>` elements plus `<nextPageToken>` (XEP-0059 semantics for pagination).

**CancelTask:** idempotent; terminal tasks return A2A `TaskNotCancelableError` mapped to XMPP error (§8).

### 6.6 Agent Card discovery

| Step                  | XMPP operation                                                                            |
| --------------------- | ----------------------------------------------------------------------------------------- |
| Find agents on domain | disco#items to `agents.example` (gateway component)                                       |
| Fetch card            | PEP get `urn:xmpp:a2a:agentcard:0` on `agent@agents.example`, or IQ-get `<getAgentCard/>` |
| Verify capabilities   | disco#info features + parse `AgentCard.capabilities`                                      |
| Authenticated card    | IQ GetExtendedAgentCard (§6.11)                                                           |

Gateway MAY mirror Agent Cards from the orchestrator registry (`AgentRuntimeDescriptor`) into PEP on agent wake.

### 6.7 Relationship to Agent XMPP Adapter API Surface

Non-A2A-aware agents use `AgentMessage` (`kind`, `contentType`, `body`) instead of full A2A objects. The gateway translates:

| A2A                            | Agent XMPP Adapter                                         |
| ------------------------------ | ---------------------------------------------------------- |
| `Message` with `parts[].text`  | `AgentMessage` `kind: "text"`, `contentType: "text/plain"` |
| `Message` with structured task | `kind: "task"`, `contentType: "application/vnd.a2a+json"`  |
| `Task` status update           | `kind: "result"` or `kind: "error"`                        |
| `Artifact` with URL            | `kind: "file"`, `attachments: [FileRef]`                   |
| `contextId`                    | `threadId`                                                 |
| `messageId`                    | `id`                                                       |

A2A-aware agents SHOULD receive `contentType: application/vnd.a2a+json` bodies and handle native A2A objects internally.

---

## 7. Service Parameter Transmission

Per A2A §3.2.6 and §12.3, service parameters MUST be documented for this binding.

### 7.1 On `<message>` stanzas

Service parameters are carried in `<headers xmlns="urn:xmpp:eme:0">` (XEP-0131) as `Header/name` + `Header/value` pairs:

| Parameter                   | Example                                   |
| --------------------------- | ----------------------------------------- |
| `a2a-version`               | `1.0`                                     |
| `a2a-extensions`            | `https://example.com/extensions/geo/v1,…` |
| `a2a-return-immediately`    | `true`                                    |
| `a2a-accepted-output-modes` | `text/plain,application/json`             |
| `a2a-tenant`                | `acme`                                    |

### 7.2 On IQ stanzas

Same headers in `<headers xmlns="urn:xmpp:eme:0">` as the first child of `<query xmlns="urn:xmpp:a2a:0">`.

### 7.3 Version negotiation

If `a2a-version` is unsupported, the gateway MUST return `VersionNotSupportedError` (§8) in an IQ error or message error stanza.

---

## 8. Error Mapping

Per A2A §5.4, custom bindings MUST map A2A errors to native representations.

| A2A error                             | XMPP representation                                                                                                       |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `TaskNotFoundError`                   | `<error type="cancel"><item-not-found xmlns="urn:ietf:params:xml:ns:xmpp-stanzas"/></error>` + A2A error body in `<text>` |
| `TaskNotCancelableError`              | `<error type="modify"><not-allowed xmlns="urn:ietf:params:xml:ns:xmpp-stanzas"/></error>`                                 |
| `PushNotificationNotSupportedError`   | `<error type="cancel"><feature-not-implemented/></error>`                                                                 |
| `UnsupportedOperationError`           | `<error type="cancel"><feature-not-implemented/></error>`                                                                 |
| `ContentTypeNotSupportedError`        | `<error type="modify"><bad-request/></error>`                                                                             |
| `InvalidAgentResponseError`           | `<error type="wait"><internal-server-error/></error>`                                                                     |
| `ExtendedAgentCardNotConfiguredError` | `<error type="cancel"><item-not-found/></error>`                                                                          |
| `ExtensionSupportRequiredError`       | `<error type="modify"><bad-request/></error>`                                                                             |
| `VersionNotSupportedError`            | `<error type="modify"><bad-request/></error>`                                                                             |
| Authentication errors                 | SASL failure (connection) or `<error type="auth"><not-authorized/></error>`                                               |
| Authorization errors                  | `<error type="auth"><forbidden/></error>`                                                                                 |

**A2A error detail payload** (in `<text>` or application-specific condition):

```xml
<error type="modify">
  <bad-request xmlns="urn:ietf:params:xml:ns:xmpp-stanzas"/>
  <a2a-error xmlns="urn:xmpp:a2a:0" name="ContentTypeNotSupportedError">
    {"message":"media type image/bmp not supported","details":[…]}
  </a2a-error>
</error>
```

---

## 9. Semantics

### 9.1 Idempotency

- A2A `messageId` MUST equal the stanza `@id` and `<origin-id id>`.
- Gateway MUST deduplicate inbound stanzas by stable id (mailbox — see gateway v2 §10).
- SendMessage MAY treat duplicate `messageId` as replay; gateway returns cached `Task` / `Message` without re-invoking the agent.

### 9.2 Ordering

- Messages from a single sender to a single agent with the same `<thread>` MUST preserve order (XMPP + gateway mailbox).
- PubSub stream events for a task MUST be totally ordered by item id / sequence.
- No global ordering across tasks or contexts.

### 9.3 Delivery acknowledgements

| Layer      | Mechanism                                                            | XEP         |
| ---------- | -------------------------------------------------------------------- | ----------- |
| Transport  | `<received xmlns="urn:xmpp:receipts">`                               | XEP-0184    |
| Processing | `<markable xmlns="urn:xmpp:chat-markers:0">` + chat marker           | XEP-0333    |
| Semantic   | A2A-equivalent `xmpp.ack` via adapter API (`received` → `completed`) | Gateway MCP |

### 9.4 Store / privacy policy

`MessagePolicy` maps to XEP-0334 and XEP-0504 (when available):

| Policy field             | XMPP                                                            |
| ------------------------ | --------------------------------------------------------------- |
| `store: false`           | `<no-store xmlns="urn:xmpp:hints"/>`                            |
| `store: true`            | `<store xmlns="urn:xmpp:hints"/>`                               |
| `trainingAllowed: false` | Data policy extension (XEP-0504) in JSON metadata               |
| `sensitivity`            | Security label (XEP-0258) in metadata for regulated deployments |

---

## 10. XEP Profile

### 10.1 Required for A2A-over-XMPP

| XEP               | Name                       | A2A role                                              |
| ----------------- | -------------------------- | ----------------------------------------------------- |
| Core + IM         | RFC 6120/6121              | Message transport, threads, JIDs                      |
| XEP-0030          | Service Discovery          | Agent + gateway capability discovery                  |
| XEP-0060          | Pub-Sub                    | Task streaming, Agent Card PEP, events                |
| XEP-0114          | Jabber Component Protocol  | Gateway owns agent domain                             |
| XEP-0163          | Personal Eventing Protocol | Agent Card publication                                |
| XEP-0198          | Stream Management          | Reliable gateway ↔ server link                        |
| XEP-0313          | MAM                        | Task/message history (GetTask history, ListTasks aid) |
| XEP-0359          | Stable Stanza IDs          | `messageId` / idempotency                             |
| XEP-0432-inspired | JSON Messaging             | A2A JSON in `<payload>`                               |
| XEP-0461          | Message Replies            | `replyTo` / threading                                 |
| XEP-0481-inspired | Content Types              | `content-type` element                                |

### 10.2 Strongly recommended

| XEP                 | A2A role                                           |
| ------------------- | -------------------------------------------------- |
| XEP-0059            | Result Set Management — ListTasks / MAM pagination |
| XEP-0100            | Gateway interaction model                          |
| XEP-0131            | Service parameter headers                          |
| XEP-0184            | Delivery receipts                                  |
| XEP-0333            | Chat markers (seen / processed)                    |
| XEP-0334            | Processing hints (store policy)                    |
| XEP-0355            | Namespace delegation to gateway                    |
| XEP-0363            | HTTP File Upload — artifacts                       |
| XEP-0446 / XEP-0447 | File metadata + stateless sharing                  |
| XEP-0045            | MUC — multi-party task contexts                    |

### 10.3 Optional / enterprise

| XEP                 | A2A role                                      |
| ------------------- | --------------------------------------------- |
| XEP-0258            | Security labels — `MessagePolicy.sensitivity` |
| XEP-0384 / XEP-0420 | E2E encryption                                |
| XEP-0475 / XEP-0477 | Signed / encrypted PubSub events              |
| XEP-0504            | Data policy / training flags                  |
| XEP-0115            | Entity capabilities caching                   |

---

## 11. Security

Per A2A §7 and §13:

| Concern               | XMPP approach                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------ |
| Transport encryption  | TLS on c2s/s2s (required)                                                                        |
| Client authentication | SASL (PLAIN, SCRAM, external cert)                                                               |
| Agent authentication  | Mutual trust via server + gateway routing; agent JIDs are gateway-provisioned                    |
| Agent Card signing    | `AgentCard.signatures` (JWS) verified by client; gateway MAY sign cards it publishes             |
| Extended card         | IQ GetExtendedAgentCard over authenticated session only                                          |
| Authorization         | Gateway enforces JID-based ACLs + A2A tenant parameter; ListTasks / GetTask scoped per A2A §13.1 |
| Push webhook SSRF     | Gateway validates webhook URLs before CreatePushNotificationConfig (A2A §13.2)                   |

OAuth/API-key schemes declared in `AgentCard.securitySchemes` apply to HTTP bindings. For pure XMPP clients, SASL and server-side ACLs are the primary control; OAuth MAY be used for HTTP fallback endpoints listed in the same Agent Card.

---

## 12. Worked Examples

### 12.1 Basic task execution (SendMessage → Task completed)

**Client → Agent**

```xml
<message to="researcher@agents.example" type="chat" id="m1">
  <thread>ctx-1</thread>
  <body>What is XEP-0363?</body>
  <payload xmlns="urn:xmpp:json-msg:0" datatype="application/vnd.a2a+json">
  {"a2a":{"messageId":"m1","role":"ROLE_USER","parts":[{"text":"What is XEP-0363?"}]}}
  </payload>
</message>
```

**Agent → Client (completed task)**

```xml
<message from="researcher@agents.example" to="client@example.com" type="chat" id="m2">
  <thread>ctx-1</thread>
  <reply xmlns="urn:xmpp:reply:0" id="m1"/>
  <body>XEP-0363 defines HTTP File Upload…</body>
  <payload xmlns="urn:xmpp:json-msg:0" datatype="application/vnd.a2a+json">
  {"a2a":{"task":{"id":"t1","contextId":"ctx-1","status":{"state":"TASK_STATE_COMPLETED"},…}}}
  </payload>
</message>
```

### 12.2 Streaming task updates

After SendStreamingMessage, client subscribes to `urn:xmpp:a2a:task:t1:stream` on `pubsub.agents.example`. Items arrive as:

```json
{
  "statusUpdate": {
    "taskId": "t1",
    "contextId": "ctx-1",
    "status": { "state": "TASK_STATE_WORKING", "timestamp": "…" }
  }
}
```

```json
{
  "artifactUpdate": {
    "taskId": "t1",
    "contextId": "ctx-1",
    "artifact": { "artifactId": "a1", "parts": [{ "url": "https://…/report.pdf", "mediaType": "application/pdf" }] },
    "lastChunk": true
  }
}
```

### 12.3 GetTask (polling)

```xml
<iq type="get" to="researcher@agents.example" id="iq1">
  <query xmlns="urn:xmpp:a2a:0">
    <headers xmlns="urn:xmpp:eme:0">
      <header name="a2a-version"><value>1.0</value></header>
    </headers>
    <getTask id="t1" historyLength="5"/>
  </query>
</iq>
```

---

## 13. Implementation Notes (NanoClaw)

Current gateway code aligns with this binding as follows:

| Binding element              | Implementation status                                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| JSON message payload         | `packages/agent-xmpp/gateway/src/xep-plugins/message.ts`                                                                  |
| Stable IDs (XEP-0359)        | `extractStableId`, `<origin-id>`                                                                                          |
| Replies (XEP-0461)           | `<reply xmlns="urn:xmpp:reply:0">`                                                                                        |
| Content type                 | `<content-type xmlns="urn:xmpp:content-type:0">`                                                                          |
| Store hints (XEP-0334)       | `applyStoreHints`                                                                                                         |
| PubSub events                | `xep-plugins/pubsub.ts`                                                                                                   |
| MAM archive                  | `xep-plugins/mam.ts`                                                                                                      |
| Discovery                    | `xep-plugins/discovery.ts`                                                                                                |
| **Binding identification**   | `protocol/a2a-binding.ts`, `xep-plugins/a2a-binding.ts` — Agent Card + `supportedInterfaces`, PEP/IQ fetch, gateway disco |
| A2A IQ namespace (task CRUD) | **Planned** — push config, extended card                                                                                  |
| StreamResponse PubSub stream | **Planned** — task lifecycle events                                                                                       |

Agents behind the gateway continue to use MCP + inbound JSON (adapter API Surface); the gateway performs A2A ↔ adapter translation at the edge.

---

## 14. Compliance Checklist

To claim `urn:xmpp:a2a:binding:1.0` support, an implementation MUST:

- [ ] Implement all A2A core operations (§6) with functionally equivalent behavior
- [ ] Encode `Message`, `Task`, `Part`, and `Artifact` per §5
- [ ] Publish Agent Card to PEP or equivalent (§5.5)
- [ ] Map all A2A errors (§8)
- [ ] Transmit service parameters (§7)
- [ ] Support idempotent SendMessage via stanza ids (§9.1)
- [ ] Document streaming and push capabilities honestly in Agent Card
- [ ] Preserve event ordering for streams (§6.2)

---

## 15. Version History

| Version   | Date       | Changes                                    |
| --------- | ---------- | ------------------------------------------ |
| 1.0 draft | 2026-07-04 | Initial mapping from A2A v1.0 to XMPP/XEPs |
