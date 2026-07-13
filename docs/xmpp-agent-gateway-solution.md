# NanoClaw Multi-Agent XMPP Gateway: Implemented Solution

## 1. Purpose and status

This document describes the XMPP agent gateway that is implemented in this repository. It focuses on the changes made to NanoClaw to support multiple independently addressable agents, the provisioning control plane, human and agent messaging, remote method discovery and invocation, and the use of NanoClaw's existing per-session mailboxes as the only host-to-agent transport.

The implementation deliberately keeps the gateway small:

- one embedded XMPP external component serves many logical agents;
- every agent has a stable bare JID and its own NanoClaw agent group;
- every agent session retains its own `inbound.db` and `outbound.db`;
- gateway-to-agent work is written to `inbound.db` through an interface;
- agent-to-gateway work is written to `outbound.db` through the normal agent-runner path;
- discovery metadata and remote tasks are durable in the central NanoClaw database;
- provisioning is handled by a separate HTTP control plane;
- no HTTP bridge, webhook, file watcher, stdin protocol, per-agent gateway process, or legacy XMPP MCP transport remains in the runtime path.

This is an implementation document, not a statement that every proposal in `docs/xmpp-agent-gateway-spec.md` is complete. Section 15 records the current limitations and intentional extension points.

## 2. Design goals

The solution is built around six invariants.

1. **The JID identifies the logical agent.** A stable bare JID is the lookup key for routing, manifests, task ownership, discovery, outbound identity, and provisioning cleanup.
2. **The XMPP component is shared infrastructure.** Adding an agent creates data and an XMPP identity; it does not start another component connection.
3. **NanoClaw's session databases remain the runtime boundary.** The host writes `inbound.db`, the container writes `outbound.db`, and neither side gains a second runtime transport.
4. **Each agent remains isolated by NanoClaw's existing entity model.** An agent has its own agent group, container configuration, filesystem, messaging group, wiring, sessions, and session databases.
5. **Remote calls are durable tasks, not transient RPC promises.** Task state, events, schemas, idempotency, deadlines, and synchronous waiters are persisted.
6. **The small number of NanoClaw core changes are generic.** The inbound transport and channel sender-identity hooks are reusable by future transports and channels.

## 3. Architecture

The control plane provisions and removes agents. The data plane runs inside the NanoClaw host and exchanges messages with agent containers through the standard session databases.

```text
                                      control plane
  operator ----------------------------------------------------------------+
     |                                                                     |
     | POST /v1/agents                                                     |
     v                                                                     |
  Orchestrator API                                                         |
     |                                                                     |
     +--> Openfire REST: user, vCard, optional shared groups               |
     +--> NanoClaw central DB: agent group, config, inbox, wiring          |
     +--> group filesystem                                                 |
     +--> Agent API manifest                                               |
                                                                           |
                                      data plane                           |
  XMPP clients / remote agents                                             |
     |                                                                     |
     v                                                                     |
  Openfire <-- XEP-0114 --> one embedded XMPP component                    |
                                 |                                         |
                                 | recipient bare JID                      |
                                 v                                         |
                         XMPP channel plugin                               |
                                 |                                         |
                  +--------------+---------------+                         |
                  |                              |                         |
             chat/form input               task invocation                 |
                  |                              |                         |
                  v                              v                         |
             NanoClaw router          XMPP task gateway service            |
                  |                              |                         |
                  +--------------+---------------+                         |
                                 |                                         |
                     AgentInboundTransport                                 |
                       (`session_db`)                                      |
                                 |                                         |
                                 v                                         |
        data/v2-sessions/<agent-group>/<session>/inbound.db                |
                                 |                                         |
                                 v                                         |
                       per-session container                               |
                                 |                                         |
                                 v                                         |
        data/v2-sessions/<agent-group>/<session>/outbound.db               |
                                 |                                         |
                                 v                                         |
                         NanoClaw delivery poll                            |
                                 |                                         |
                                 v                                         |
                         XMPP channel plugin ------------------------------+
```

There are three database scopes:

| Scope | Database | Responsibility |
|---|---|---|
| Installation | `data/v2.db` | Agent identities, agent groups, inbox wiring, container config, manifests, tasks, task events, and task waiters |
| Session inbound | `inbound.db` | Host-to-container messages, reply routing, and allowed destinations |
| Session outbound | `outbound.db` | Container-to-host messages, gateway requests, processing acknowledgements, and runtime state |

## 4. Repository layout

| Area | Main files | Responsibility |
|---|---|---|
| Channel plugin | `src/channels/xmpp-bridge.ts`, `src/channels/xmpp-agent-iq.ts` | Registers XMPP as a NanoClaw channel, owns the component, bridges chat/tasks, handles IQ discovery and ping |
| XMPP wire implementation | `packages/agent-xmpp/gateway/src/` | XEP-0114 connection, stanza routing, messages, receipts, chat states, ping, discovery, data forms, and task codecs |
| Shared protocol | `packages/agent-xmpp/protocol/src/` | Agent manifests, tasks, gateway mailbox messages, and NanoClaw/XMPP conversion types |
| Inbound transport seam | `src/agent-inbound/` | Defines the host-to-agent delivery interface and its `session_db` implementation |
| Task service | `src/modules/xmpp-agent-gateway/` | Manifest store, discovery, schema validation, task state machine, idempotency, and waiter completion |
| Agent MCP surface | `container/agent-runner/src/mcp-tools/xmpp-agent-gateway.ts` | Tools used by an agent to discover/call other agents and to operate inbound tasks |
| Provisioning | `packages/orchestrator/src/` | HTTP API, Openfire identity management, NanoClaw entity creation/deletion, and rollback |
| Schema | `src/db/migrations/099-agent-xmpp-orchestrator.ts`, `100-xmpp-agent-gateway.ts` | Multi-agent identity, provisioning metadata, manifests, durable tasks, events, and waiters |
| Integration tests | `packages/agent-xmpp/integration/e2e-embedded-gateway.ts` | Live Openfire verification of ping, chat routing, discovery, schemas, and remote task stanzas |

## 5. Changes to NanoClaw for multiple agents

### 5.1 Stable XMPP identity on the agent group

Migration 099 adds nullable `agent_groups.xmpp_jid` and a unique partial index. The agent group is the authoritative NanoClaw owner of the JID. The separate `orchestrator_agents` row records provisioning-only metadata such as tenant and spawn environment, but does not duplicate the identity.

This provides a direct mapping:

```text
bare XMPP JID -> agent_groups.xmpp_jid -> agent group -> sessions and container
```

The unique index prevents two local agents from claiming the same JID. All runtime lookups normalize to the bare JID, so XMPP resources do not create separate agents.

### 5.2 One inbox messaging group per agent

Provisioning creates a direct-message `messaging_groups` row with:

```text
channel_type = xmpp
instance     = xmpp
platform_id = <the agent's own bare JID>
```

That row represents the agent's XMPP inbox, not a remote human conversation. A `messaging_group_agents` row wires the inbox to exactly that agent group with a shared session, all-sender scope, and a match-all engagement pattern. Consequently, an inbound stanza addressed to `alpha@agents.example` cannot accidentally wake `beta@agents.example`.

The shared XMPP adapter places the recipient agent JID in the inbound event's `instance`. `routeXmppInbound()` then:

1. resolves `instance` through `agent_groups.xmpp_jid`;
2. finds that JID's inbox messaging group;
3. confirms that the inbox is wired to the resolved agent group;
4. applies the normal NanoClaw access gate;
5. resolves the agent's session; and
6. hands the message to the configured inbound transport.

Unknown logical-agent JIDs are dropped and logged. They are never routed to a default local agent.

### 5.3 Switchable host-to-agent transport

`src/agent-inbound/types.ts` introduces the small `AgentInboundTransport` interface:

```ts
interface AgentInboundTransport {
  readonly kind: string;
  deliver(options: AgentInboundDeliveryOptions): Promise<void>;
}
```

Both ordinary NanoClaw routing and remote-task delivery call this interface. The only registered implementation is currently `SessionDbAgentInboundTransport`, selected by `AGENT_INBOUND_TRANSPORT=session_db` or by the default when the variable is unset.

The implementation performs the existing NanoClaw behavior:

- insert the message into the session's `inbound.db`;
- update reply routing and the peer destination for an XMPP inbox;
- start agent-specific typing refresh when applicable;
- wake the session container; and
- leave the inbound row pending if the container cannot be started, allowing the normal host sweep to retry.

This interface is intentionally narrow. Replacing the delivery mechanism later does not require changing the router or task service, while the deployed system uses only the proven session mailbox.

### 5.4 Correct reply routing for agent inbox sessions

For ordinary messaging groups, NanoClaw can derive the reply destination from `messaging_groups.platform_id`. For an XMPP agent inbox that value is the local agent's own JID, so using it would cause self-addressed replies.

The session transport therefore stamps `session_routing` with the actual inbound peer on every XMPP delivery:

```text
channel_type = xmpp
platform_id = inbound sender bare/full JID
thread_id = inbound XMPP thread or task ID
```

It also ensures that the peer is present in the session's destinations. An agent response without an explicit destination consequently goes back to the current human or calling agent, while explicit agent-to-agent sends remain subject to NanoClaw's destination rules.

### 5.5 Agent-specific outbound identity

Before this work, a channel adapter generally needed only a destination. A shared XMPP component must also know which logical agent is speaking.

The generic channel contract now supports:

- `resolveSenderIdentity(agentGroupId)`;
- an optional `senderIdentity` on `deliver()`;
- the same identity on typing-state calls; and
- `agentGroupId` propagation through the host delivery adapter.

The XMPP plugin resolves the identity from `agent_groups.xmpp_jid`. Message stanzas, task stanzas, receipts, and chat-state notifications can therefore carry the correct logical agent in `from`, even though all agents share one physical XEP-0114 connection.

### 5.6 Per-agent container environment

The orchestrator persists a JSON `spawn_env`. At container creation, NanoClaw injects it after OneCLI configuration so local provider overrides take precedence. Every provisioned agent receives at least:

```text
XMPP_AGENT_JID=<stable bare JID>
XMPP_TENANT_ID=<tenant>
```

Optional scenario-specific values may also be supplied. Non-orchestrated agent groups with an `xmpp_jid` still receive `XMPP_AGENT_JID`, keeping identity resolution independent of the provisioning API.

## 6. XMPP channel plugin

### 6.1 Shared external component

The plugin is registered through NanoClaw's normal channel registry, like the WhatsApp or Telegram adapters. It starts only when `XMPP_COMPONENT_JID` and `XMPP_COMPONENT_SECRET` are configured. On host startup it opens one external-component connection; on shutdown it closes it.

The connection uses [XEP-0114: Jabber Component Protocol](https://xmpp.org/extensions/xep-0114.html). Openfire delegates the configured component domain to the gateway. The gateway then treats the local part of a recipient JID as a virtual logical agent and resolves the complete bare JID against provisioned agents.

### 6.2 Runtime mailbox boundary

`GatewayRuntimeMailbox` is the XMPP package's only dependency on its embedding runtime. The NanoClaw adapter implements it with four operations:

| Operation | NanoClaw behavior |
|---|---|
| `deliverInbound` | Convert the stanza payload to a NanoClaw inbound event and route it to the recipient agent's session |
| `deliverFormResponse` | Resolve an XEP-0004 answer, deliver the selected value, and complete the pending NanoClaw action |
| `deliverTaskInvocation` | Validate and persist a remote invocation, then write a task message to the target's `inbound.db` |
| `deliverTaskEvent` | Validate the sender and update or forward the durable task |

No XMPP package writes NanoClaw databases directly. The host adapter and task service own that integration.

### 6.3 Human messaging

For a human-to-agent message:

```text
human XMPP client
  -> Openfire
  -> shared component
  -> resolve recipient agent JID
  -> NanoClaw router
  -> target session inbound.db
  -> target container
```

For the reply:

```text
target container
  -> target session outbound.db
  -> NanoClaw delivery poll
  -> XMPP adapter with target agent's sender identity
  -> Openfire
  -> human XMPP client
```

The gateway sends chat-state notifications using [XEP-0085](https://xmpp.org/extensions/xep-0085.html) and delivery receipts using [XEP-0184](https://xmpp.org/extensions/xep-0184.html). Thread IDs are preserved where provided. Structured ask-question responses use [XEP-0004: Data Forms](https://xmpp.org/extensions/xep-0004.html).

For a direct chat, NanoClaw deliberately separates the sender's routing identity from its delivery address:

- the bare JID selects the user, messaging group, and long-lived agent session;
- the full JID that originated the stanza is stored as the inbound event's `replyTo` address; and
- the response plus all XEP-0085 state transitions are sent to that same full JID.

This follows the resource-routing behavior in RFC 6121 without creating one NanoClaw session per XMPP client resource. It also prevents another resource logged in with the same account from receiving the response or the terminal `<inactive/>` state. Every terminal response and error stops the typing refresh and emits `inactive`, so a client cannot remain stuck in `composing` after the agent run ends. If the heartbeat becomes stale before a terminal response exists—for example, when a provider aborts—the refresh loop emits `inactive` before discarding its routing target. This closes the other path that could otherwise strand a client in the composing state.

Registered virtual agents also implement normal roster behavior. A presence subscription receives `subscribed` followed by type-less available presence; a server probe receives current available presence with `<show>chat</show>`. These host-side responses do not wake the agent container. Each agent exposes an [XEP-0054 vCard](https://xmpp.org/extensions/xep-0054.html) derived from its registered manifest (`FN`, `NICKNAME`, `JABBERID`, and optional description/homepage fields).

### 6.4 Agent-to-agent chat

Agent-to-agent chat uses the same path as human chat. The sender writes an ordinary outbound message addressed to the destination JID. The shared component sends it with the caller's agent JID, receives the server-routed stanza for the target virtual JID, and routes it into the target's independent session mailbox.

Self-sent loopback stanzas are discarded by comparing bare sender and recipient JIDs. This prevents an agent's outbound copy from being interpreted as new inbound work for itself.

## 7. Provisioning and removal

### 7.1 Orchestrator API

The orchestrator is a Fastify HTTP service in `packages/orchestrator`. It initializes the central NanoClaw database and applies the same migrations as the host.

| Method | Path | Behavior |
|---|---|---|
| `GET` | `/health` | Unauthenticated liveness check |
| `GET` | `/v1/agents` | List provisioned agents and their NanoClaw/JID summary |
| `GET` | `/v1/agents/:id` | Return one provisioned agent, including its spawn environment |
| `POST` | `/v1/agents` | Provision an XMPP identity and complete NanoClaw agent |
| `DELETE` | `/v1/agents/:id` | Remove the XMPP identity and all owned NanoClaw state |

If `ORCHESTRATOR_API_SECRET` is set, all `/v1` requests require `Authorization: Bearer <secret>`. Without a secret, the server refuses to bind a non-loopback host. The default bind is `127.0.0.1:19300`.

Start it from the repository root with Node 22:

```bash
pnpm --filter orchestrator start
```

### 7.2 Provision request

A request can set identity, runtime, personality, skills, MCP servers, XMPP groups, and the public Agent API manifest:

```json
{
  "name": "Accounts Agent",
  "agentId": "accounts",
  "tenantId": "agents.example",
  "displayName": "Accounts",
  "personality": {
    "assistantName": "Accounts",
    "instructions": "Handle account and invoice questions."
  },
  "provider": "claude",
  "model": "configured-model-name",
  "skills": ["accounting"],
  "mcpServers": [
    {
      "name": "ledger",
      "command": "ledger-mcp",
      "args": ["serve"]
    }
  ],
  "groups": ["finance-agents"],
  "agentApiManifest": {
    "capabilities": {
      "tools": { "listChanged": true },
      "progress": true,
      "cancellation": true,
      "inputRequired": true,
      "structuredOutput": true
    },
    "operations": [
      {
        "name": "invoice.lookup",
        "description": "Look up an invoice.",
        "inputSchema": {
          "type": "object",
          "properties": { "invoiceId": { "type": "string" } },
          "required": ["invoiceId"],
          "additionalProperties": false
        },
        "outputSchema": {
          "type": "object",
          "properties": { "status": { "type": "string" } },
          "required": ["status"]
        }
      }
    ]
  }
}
```

When no manifest is supplied, the orchestrator registers a default `conversation.respond` operation with structured `{ "message": string }` input and `{ "response": string }` output.

The success response includes the orchestrator ID, NanoClaw agent-group ID, filesystem folder, JID, and inbox messaging-group ID. The generated XMPP password is returned by the provisioning function for callers that need it, but the HTTP response intentionally does not expose it.

### 7.3 Provision transaction

Provisioning performs these steps in order:

1. derive the bare JID from `tenantId`, `agentId`, and the configured base domain;
2. generate a cryptographically random password;
3. create the Openfire user and vCard;
4. optionally ensure shared groups and add the user to them;
5. create a NanoClaw agent group with the JID;
6. initialize the group's filesystem and personality instructions;
7. create and populate the container configuration;
8. create or reuse the XMPP inbox messaging group;
9. wire that inbox to the new agent group;
10. persist the orchestrator record and spawn environment; and
11. normalize, digest, and register the Agent API manifest.

Every side effect after identity creation is added to an undo stack. On failure, cleanup runs in reverse order and is best effort, including removal of database rows, group files, and the Openfire user. Identity creation itself also performs a compensating Openfire delete if vCard or group work fails. This avoids partially provisioned agents that appear in only one subsystem.

For tests and local development, `ORCHESTRATOR_SKIP_OPENFIRE=1` skips Openfire mutations while retaining the full NanoClaw provisioning path.

### 7.4 Removal

Deletion is addressed by orchestrator ID and removes:

- the Openfire user;
- all sessions and their `inbound.db`, `outbound.db`, and outbox files;
- inbox wirings and messaging groups;
- destinations involving the agent;
- registered XMPP manifests;
- container configuration;
- the NanoClaw agent group;
- the orchestrator row; and
- the group's filesystem directory.

Session and filesystem cleanup is best effort. Referentially constrained rows, such as destinations, are deleted before the agent group.

## 8. Agent API manifests and discovery

### 8.1 Manifest model

Each logical agent advertises a versioned manifest containing:

- agent JID, name, title, version, and optional descriptive metadata;
- capability flags;
- named operations;
- JSON input and optional output schemas;
- authorization requirements; and
- MCP-style behavioral annotations such as read-only, destructive, and idempotent hints.

Registration canonicalizes the manifest and stores its digest. Operation input and output schemas also receive stable digests. A task pins the API version and both schema digests so later manifest changes cannot silently alter an in-flight contract.

An agent can update its own manifest through `agent_api.register`; the service rejects a manifest whose JID differs from the calling agent's JID.

### 8.2 Native XMPP discovery

Remote XMPP peers discover the gateway and logical agents with [XEP-0030: Service Discovery](https://xmpp.org/extensions/xep-0030.html). Structured metadata is returned in [XEP-0004](https://xmpp.org/extensions/xep-0004.html) result forms.

The implemented queries are:

| Target and query | Result |
|---|---|
| Component `disco#info` | Gateway identity and supported discovery/task namespaces |
| Component `disco#items`, node `urn:businessos:agent-directory:1` | Tenant-visible logical-agent JIDs |
| Agent `disco#info`, node `urn:businessos:mcp-endpoint:1` | Canonical endpoint ID, title, version, manifest digest, availability, and cold-start support |
| Agent `disco#items`, node `urn:businessos:agent-api:1` | Operation nodes |
| Agent operation `disco#info` | Name, description, version, schema digests, and MCP annotations |
| Agent `<schema/>` query | Input or output JSON Schema and its digest |

The canonical endpoint form is:

```text
xmpp+mcp://<agent-bare-jid>
```

The `urn:businessos:*` nodes are project extension namespaces carried over standard XMPP discovery; they are not registered XSF protocols.

Discovery is tenant filtered. IQ discovery is handled entirely by the host and does not write an inbound row or wake an agent container.

### 8.3 Agent-side discovery tools

Containers see the same registry through MCP tools:

| Tool | Purpose |
|---|---|
| `agents.discover_endpoints` | Search authorized endpoints by query |
| `agents.describe_endpoint` | Read one endpoint descriptor |
| `agents.list_tools` | List the endpoint's operations and schemas |

This gives local agents an ergonomic MCP interface while remote XMPP agents use service discovery. Both surfaces read the same durable manifest store.

The agent-runner composes a concise usage fragment whenever `XMPP_AGENT_JID` is present. For a request such as “ask Jane how she is and tell me her reply”, the required same-turn sequence is:

1. call `agents.discover_endpoints` with Jane's name or JID;
2. select the returned canonical `xmpp+mcp://` endpoint and its exact operation schema;
3. call `agents.call_tool` with operation `conversation.respond` and arguments `{ "message": "How are you?" }`;
4. wait for the durable task result; and
5. relay the structured `response` to the requesting human.

The instructions explicitly forbid stopping after merely promising to look up the endpoint. They also no longer refer to the retired `xmpp.discover_agents` or `xmpp.send_message` tools. When a deployment uses `NANOCLAW_MCP_TOOL_ALLOWLIST`, the generated prompt only claims that optional tools such as `send_message` exist when they are actually enabled; the remote Agent API workflow remains available through the four compact discovery/call tools.

## 9. Calling methods on agents

### 9.1 Why calls are tasks

An agent operation can take longer than an XMPP round trip, require clarification, emit progress, survive a container cold start, or be cancelled. The gateway therefore models every invocation as a durable task with a state machine rather than as a direct in-memory RPC.

Important task fields include:

- caller and target bare JIDs;
- caller session;
- tenant and optional workspace;
- endpoint, operation, and API version;
- pinned input/output schema digests;
- structured arguments and result;
- root and parent task IDs for delegation;
- idempotency key and correlation ID;
- deadline and attempt number; and
- lifecycle timestamps and structured errors.

### 9.2 Caller tools

| Tool | Semantics |
|---|---|
| `agents.start_tool` | Validate and persist a task, deliver it, and immediately return a task handle |
| `agents.call_tool` | Do the same but persist a waiter and wait for a terminal result or input request |
| `agents.get_task` | Read current durable state and metadata |
| `agents.get_result` | Read the structured result or error |
| `agents.cancel_task` | Request cooperative cancellation |
| `agents.answer_input` | Validate and deliver an answer to a pending input request |

`agents.call_tool` is only a synchronous convenience at the MCP boundary. The underlying call remains a durable task. The agent-runner writes the gateway request to `outbound.db`, then polls `inbound.db` for the correlated system response. The host persists a waiter so completion is not dependent on an in-memory callback.

### 9.3 Target tools

An agent handling a task uses:

| Tool | Semantics |
|---|---|
| `task.report_progress` | Append a progress event |
| `task.request_input` | Pause in `input_required` and return a structured question/schema to the caller |
| `task.complete` | Validate the output against the pinned output schema and complete the task |
| `task.fail` | Complete with a structured code, message, and retryability flag |
| `task.cancelled` | Confirm cooperative cancellation |

The inbound task message contains the operation, arguments, caller, task ID, and an instruction to use these lifecycle tools. The target never needs direct access to the central database.

### 9.4 Local caller to local target

When both agents are provisioned in this NanoClaw installation, XMPP is the identity and protocol model but the runtime delivery takes the shortest reliable path:

```text
caller MCP tool
  -> caller outbound.db system request
  -> host task service
  -> validate tenant, operation, version, schema, authorization
  -> persist task and optional waiter in data/v2.db
  -> resolve target JID to local agent group
  -> target inbound.db task message
  -> wake target container
  -> target task.complete / task.fail / task.request_input
  -> target outbound.db system request
  -> host updates durable task
  -> caller inbound.db correlated response
  -> caller MCP tool returns
```

No stanza is needed between two agents hosted by the same gateway. The caller and target still use bare JIDs, manifests, task records, schema digests, and the same lifecycle as remote calls. This keeps local delivery efficient without creating a second semantic model.

### 9.5 Local caller to remote XMPP target

If the target JID is not a local agent group, the task service serializes the durable task as an XMPP task stanza and sends it through the channel adapter using the caller's JID:

```text
local caller -> outbound.db -> task store -> XMPP task stanza -> remote gateway/agent
remote events -> XMPP event stanza -> local task store -> caller inbound.db
```

Progress, input requests, completion, failure, and cancellation are task-event stanzas. The custom task payload uses `urn:businessos:agent-task:1`. Task messages include a stable origin identifier following [XEP-0359: Unique and Stable Stanza IDs](https://xmpp.org/extensions/xep-0359.html) and request a delivery receipt using XEP-0184.

### 9.6 Remote XMPP caller to local target

The inverse path validates the inbound wire invocation before waking a local agent:

1. resolve the addressed target JID to a provisioned local agent;
2. require the wire tenant to match the target's tenant;
3. resolve the advertised API version and operation;
4. verify the input schema digest;
5. validate the arguments;
6. persist the task; and
7. deliver the invocation to the target's `inbound.db`.

Target lifecycle reports update the durable task and are emitted back to the remote caller as task-event stanzas.

### 9.7 State, validation, and idempotency

The lifecycle includes accepted, running, input-required, cancelling, completed, failed, cancelled, rejected, and timed-out outcomes. The store enforces valid transitions and records ordered events separately from the current task snapshot.

Before delivery, the service checks:

- endpoint syntax and tenant visibility;
- operation existence and selected API version;
- authorization flags;
- input against the operation's JSON Schema;
- parent-task visibility and maximum delegation depth; and
- the caller/target role for lifecycle actions.

Results are validated against the pinned output schema before completion. The current validator intentionally supports the JSON Schema subset used by manifests in this system; see Section 15.

An optional idempotency key is unique across caller, endpoint, operation, version, and key. Repeating a call returns the existing task. A completed duplicate returns its prior result; an in-progress synchronous duplicate attaches another durable waiter. Nested calls retain `rootTaskId` and `parentTaskId`, and delegation depth is capped at eight.

Deadlines are persisted. Reading a non-terminal task after its deadline transitions it to `timed_out` with a structured `deadline-exceeded` error.

## 10. Ping, discovery, and liveness

The component automatically answers [XEP-0199: XMPP Ping](https://xmpp.org/extensions/xep-0199.html) for:

- the component JID; and
- every registered logical agent JID.

The reply preserves the requested logical address in `from`. Ping is handled in the IQ layer, so it does not route to a session, create a task, wake a container, or consume model tokens. This is important for monitoring many dormant agents behind one component.

Manifest availability is currently stored as `dormant`. A discovery result indicates cold-start support; it does not claim that a container is continuously running. Actual containers remain demand started by NanoClaw.

## 11. Persistence model

Migration 099 introduces:

- `agent_groups.xmpp_jid` with a unique partial index; and
- `orchestrator_agents`, keyed by orchestrator ID and uniquely linked to an agent group.

Migration 100 introduces:

- `xmpp_agent_apis`: versioned manifests, tenant, digest, and availability;
- `xmpp_agent_tasks`: durable current task state and all pinned call metadata;
- `xmpp_agent_task_events`: ordered lifecycle history; and
- `xmpp_agent_task_waiters`: durable mappings from a synchronous call to the caller session/request.

The session databases remain unchanged in ownership:

| Flow | Writer | Reader |
|---|---|---|
| Gateway or host to agent | Host writes `inbound.db` | Container reads `inbound.db` |
| Agent response or gateway action | Container writes `outbound.db` | Host reads `outbound.db` |

This preserves NanoClaw's one-writer-per-file rule and cross-mount visibility behavior.

## 12. Security and trust boundaries

### 12.1 Provisioning API

- unauthenticated health is intentionally separate from privileged `/v1` operations;
- a Bearer secret protects `/v1` when configured;
- a secret is mandatory for non-loopback binding;
- Openfire REST supports its shared-secret mode and an admin Basic-auth bootstrap fallback; and
- redirects and HTML login responses are treated as authentication failures rather than successful REST calls.

### 12.2 Agent identity

- the agent group's JID is unique and authoritative;
- outbound identity is derived from the sending agent group, not accepted from model-authored text;
- manifest self-registration requires the caller's JID;
- task events must be sent by the recorded caller or target, depending on the event; and
- bare-JID comparisons prevent resource spoofing from creating another logical local agent.

### 12.3 Tenant isolation

- discovery lists only manifests registered for the caller's tenant;
- local calls require caller and target manifests in the same tenant;
- inbound remote invocations must declare the target tenant; and
- task reads and mutations are tenant checked.

This is application-level tenant isolation. It assumes the XMPP server and gateway connection are trusted to provide truthful stanza addressing. Section 15 describes authorization work that remains.

### 12.4 Schema and capability enforcement

The gateway validates structured arguments before delivery and structured results before completion. An advertised `approvalRequired` operation is currently rejected, not interactively approved. Any non-empty `requiredPermissions` list is also rejected because a permission-grant model has not yet been connected to remote calls. This fail-closed behavior prevents the gateway from pretending authorization was performed.

## 13. Reliability and failure behavior

- **Cold starts:** writing a task or chat message wakes the target container. If spawn fails transiently, the inbound row remains pending for the regular host sweep.
- **Durability:** manifests, tasks, events, deadlines, idempotency keys, and call waiters survive host process memory loss.
- **Duplicate calls:** idempotency returns the existing task rather than running it twice.
- **Partial provisioning:** reverse-order compensation removes completed side effects.
- **Partial deletion:** Openfire, session-directory, and group-directory cleanup is best effort, while central database deletion follows foreign-key order.
- **Unavailable remote delivery:** a remote call fails visibly if the XMPP adapter is unavailable; it is not silently rerouted to a local agent.
- **Discovery and ping isolation:** IQ control traffic is answered by the host and never wakes an agent.
- **Typing and multi-resource delivery:** chat-state updates are best effort and cannot block message routing. The initiating full JID is retained as `replyTo`; composing, the response or error, and terminal `inactive` all target that resource. The bare JID remains the routing/session identity.
- **Task cancellation:** cancellation is cooperative. `cancelling` records the request; the target confirms termination with `task.cancelled`.

## 14. Standards and extension namespaces

| Protocol | Use in this solution |
|---|---|
| [XEP-0114](https://xmpp.org/extensions/xep-0114.html) | One external component connection serving the delegated logical-agent domain |
| [RFC 6121](https://xmpp.org/rfcs/rfc6121.html) | Presence subscriptions/probes and full-resource routing for direct-chat replies |
| [XEP-0030](https://xmpp.org/extensions/xep-0030.html) | Gateway, directory, endpoint, and operation discovery |
| [XEP-0004](https://xmpp.org/extensions/xep-0004.html) | Structured discovery result forms and ask-question forms |
| [XEP-0199](https://xmpp.org/extensions/xep-0199.html) | Host-side ping replies for the component and logical agents |
| [XEP-0085](https://xmpp.org/extensions/xep-0085.html) | Agent-specific composing, paused, and terminal inactive chat states |
| [XEP-0054](https://xmpp.org/extensions/xep-0054.html) | Manifest-backed vCards for virtual agent JIDs |
| [XEP-0184](https://xmpp.org/extensions/xep-0184.html) | Message delivery receipts and receipt requests on task messages |
| [XEP-0359](https://xmpp.org/extensions/xep-0359.html) | Stable origin identifiers for task stanzas |

Project-specific semantics use these extension namespaces:

```text
urn:businessos:agent-directory:1
urn:businessos:agent-api:1
urn:businessos:agent-operation:1
urn:businessos:mcp-endpoint:1
urn:businessos:agent-task:1
```

These namespaces define the agent directory, MCP projection, schemas, and durable task wire format. Standard XMPP discovery and stanza routing carry them, but the payload semantics are specific to this implementation.

## 15. Current limitations and extension points

The following are deliberate current boundaries rather than hidden claims of completeness:

1. **One component process, no gateway HA.** Multiple logical agents share one host connection. Active/active component failover and distributed task-store coordination are not implemented.
2. **Session DB is the only runtime transport.** `AgentInboundTransport` makes replacement possible, but no alternate implementation is shipped or active.
3. **Custom task protocol.** Remote method calls use the `urn:businessos:agent-task:1` extension, not a standardized XMPP RPC XEP.
4. **Small JSON Schema validator.** It covers the manifest shapes used here and does not implement the complete JSON Schema specification or external references.
5. **Fail-closed authorization placeholders.** Tenant checks and sender roles are enforced, but interactive approvals and a remote permission-grant system are not connected.
6. **Discovery availability versus XMPP presence.** Discovery reports the persisted `dormant` value and cold-start support because containers are demand started. XMPP roster presence is independently synthesized as available by the gateway for registered virtual agents; it describes reachability through the gateway, not a continuously running container.
7. **Cooperative cancellation.** The gateway records and delivers cancellation; it does not forcibly kill a target container solely for one task.
8. **Local calls optimize away XMPP.** Local-to-local task delivery uses the session DB directly. This is intentional and semantically equivalent, but deployments that require every call to traverse the XMPP server would need another transport policy.
9. **Provisioning is source-run.** The orchestrator has an API and safety checks but is not yet wired into NanoClaw's main `ncl` CLI or a production service installer.
10. **Openfire-oriented provisioning.** The runtime speaks standard external-component XMPP, while automatic identity provisioning currently targets the Openfire REST API.

The principal switch points are `AgentInboundTransport` for agent delivery, `GatewayRuntimeMailbox` for embedding the XMPP package, `ChannelAdapter.resolveSenderIdentity` for shared-identity channels, and the orchestrator's `OpenfireClient` for server-specific identity operations.

## 16. Configuration and operation

Configure the embedded component:

```bash
XMPP_COMPONENT_JID=gateway.agents.example
XMPP_AGENT_DOMAIN=agents.example
XMPP_COMPONENT_SERVICE=xmpp://127.0.0.1:5275
XMPP_COMPONENT_SECRET=component-secret
XMPP_DEFAULT_AGENT_JID=assistant@agents.example
```

Configure provisioning as needed:

```bash
OPENFIRE_URL=http://127.0.0.1:9090
OPENFIRE_REST_SECRET=<openfire-rest-secret>
OPENFIRE_XMPP_BASE_DOMAIN=agents.example
ORCHESTRATOR_HOST=127.0.0.1
ORCHESTRATOR_PORT=19300
ORCHESTRATOR_API_SECRET=<optional-on-loopback-required-off-loopback>
```

The host must run on Node 22 for this project. Build and test commands are:

```bash
pnpm run build
pnpm test
pnpm run test:xmpp-e2e
```

The live integration test starts Openfire, connects the real embedded component, and exercises the production IQ handler and durable manifest store.

For an operator-facing local demonstration, `pnpm run demo:xmpp-agents` starts Openfire, the embedded gateway, orchestrator, Rapid-MLX/OpenCode, and two independently provisioned agents, Jane and Mike. The script requires and selects Node 22. Its smoke client exits before the “ready” banner; full-JID reply routing additionally ensures that a simultaneously connected operator resource cannot race with a test resource using the same account.

The demo disables Rapid-MLX prefix caching. Jane and Mike have different large system prompts, and retaining the first agent's KV cache can leave insufficient Metal headroom to admit the second request even though the 12B model itself fits in unified memory.

Rapid-MLX 0.10.9 has a Gemma 4 tool-parser defect that affects the nested `arguments` object used by `agents.call_tool`: its non-balanced tool-call matcher stops at the first nested `}`, which truncates the call before sibling fields and can leak an internal `__Q0__` placeholder. The fix is published as [Rapid-MLX PR #1102](https://github.com/raullenchai/Rapid-MLX/pull/1102). NanoClaw keeps the correct structured Agent API instead of adding a provider-specific flattened argument format.

One cold-start limitation remains in the local harness: on a newly created Openfire volume, the admin bootstrap can confirm the XEP-0114 default secret while the component socket accepts TCP but does not answer the initial stream header. Reusing a previously initialized volume worked, but repeated clean-volume verification reproduced the silent handshake. Until that Openfire bootstrap race is fixed, a completely fresh `demo:xmpp-agents` run is not considered verified even though the standalone embedded Openfire E2E suite passes.

## 17. Verification coverage

The unit and integration suites cover the important boundaries of the solution:

- manifest normalization, digesting, registration, versioning, and discovery;
- schema validation and task state transitions;
- idempotency and durable synchronous waiters;
- provisioning, rollback, deletion, API authentication, and non-loopback safety;
- multi-agent recipient routing and independent session mailboxes;
- agent-specific outbound identities and typing state;
- full-JID direct-chat replies and terminal XEP-0085 `inactive` delivery to the initiating resource;
- RFC 6121 presence subscription/probe behavior and manifest-backed XEP-0054 vCards;
- XEP-0199 ping to the component and to multiple logical agents;
- human-to-agent delivery to two different agents;
- agent-to-human delivery with the correct `from` JID;
- agent-to-agent chat routing;
- peer discovery of the gateway, directory, endpoints, operations, annotations, and both schemas;
- remote task invocation and completion event stanzas; and
- the invariant that ping and discovery IQs do not wake agents.

The embedded live scenario is intentionally multi-agent: it registers `alpha` and `beta`, pings both, verifies available presence and vCard data, sends human messages to each, verifies a response addressed to the originating full JID, sends `alpha` to `beta`, performs discovery from another XMPP agent, and completes a remote task lifecycle.

## 18. End-to-end summary

Provisioning adds a new logical agent by creating an Openfire identity and a complete NanoClaw agent group with its own inbox, wiring, runtime configuration, filesystem, manifest, sessions, and mailbox files. It does not add another gateway.

At runtime, the shared component resolves the recipient bare JID to the correct agent group. Chats and task invocations enter only that agent's `inbound.db`; the target container responds through only its `outbound.db`. Generic sender-identity support makes the shared adapter send every response, typing state, and task event as the correct logical agent.

Agents discover one another either through XEP-0030/XEP-0004 over XMPP or through the local MCP projection of the same registry. Method calls become durable, schema-pinned tasks that work across local-local, local-remote, and remote-local boundaries, with progress, structured input, completion, failure, cancellation, deadlines, delegation limits, and idempotency.

The result is a multi-agent system that preserves NanoClaw's core isolation and mailbox architecture while adding XMPP-native addressing and discovery with minimal, reusable changes to upstream core files.
