# XMPP Agent Gateway Specification (Revision 2)

## Status

Draft v2

This revision supersedes the previous gateway specification by making the **Agent XMPP Adapter API Surface** the normative protocol definition. This document specifies the gateway architecture and implementation only.

Reference: Agent XMPP Adapter API Surface (v0.1).

---

# 1. Architectural Principles

The gateway is **not** an agent runtime.

It is an always-on XMPP gateway that:

- owns XMPP identities
- implements relevant XEPs
- wakes dormant agents
- persists messages
- injects inbound events into runners
- exposes outbound XMPP functionality through MCP

Agents never parse XMPP XML.

Agents never authenticate to XMPP.

Agents never implement XEPs.

---

# 2. High-level Architecture

```text
                Openfire
                   │
          XEP-0114 Component
                   │
          XEP-0100 Gateway Model
                   │
        ┌────────────────────────┐
        │ agent-xmpp-gateway     │
        │------------------------│
        │ XMPP                   │
        │ Wake Policy            │
        │ Mailbox                │
        │ Docker Manager         │
        │ Routing                │
        └──────────┬─────────────┘
                   │
        HTTP / JSONL Inbound
                   │
        ┌──────────▼─────────────┐
        │ NanoClaw Runner        │
        │------------------------│
        │ Resume run             │
        │ Inject event           │
        │ MCP client             │
        └──────────┬─────────────┘
                   │
              NanoClaw Agent
                   │
             MCP outbound tools
                   │
        ┌──────────▼─────────────┐
        │ agent-xmpp-mcp         │
        └────────────────────────┘
```

---

# 3. XEP-0100 Compliance

The gateway SHALL follow the Gateway Interaction model.

BusinessOS is treated as the foreign network.

Mapping:

| XEP-0100 concept | BusinessOS |
|---|---|
| Gateway | agent-xmpp-gateway |
| Foreign network | BusinessOS agent network |
| User | Human or agent |
| Transport | XMPP |

The gateway therefore owns all protocol translation.

---

# 4. Component Responsibilities

## agent-xmpp-gateway

Responsible for:

- XMPP sessions
- routing
- mailbox
- wake/sleep
- Docker lifecycle
- archive integration
- PubSub
- MUC
- policy
- delivery guarantees

It MUST NOT contain LLM logic.

---

## agent-runner

The runner is a generic execution host.

NanoClaw is one implementation.

Responsibilities:

- receive inbound HTTP/JSONL events
- start/resume NanoClaw
- inject inbound event
- expose MCP client

The runner knows nothing about XMPP.

---

## NanoClaw

NanoClaw remains unchanged.

The only integration point is:

Inbound:
- HTTP / JSONL event injection

Outbound:
- MCP tool calls

NanoClaw never sees XMPP.

---

## agent-xmpp-mcp

Implements the outbound tool surface.

Every tool defined in the API Surface is implemented here.

The gateway translates MCP calls into XMPP actions.

---

# 5. Contracts

## Gateway → Runner

Normative protocol:

HTTP or JSONL exactly as defined in the Agent XMPP Adapter API Surface.

The gateway MUST NOT invent additional message schemas.

## Runner → NanoClaw

Runner-specific API.

Not specified by this document.

## NanoClaw → Gateway

Exclusive communication mechanism:

MCP tools.

NanoClaw MUST NOT speak HTTP to the gateway except for runner lifecycle.

## Gateway → XMPP

Implementation of XMPP Core and selected XEPs.

---

# 6. Lifecycle

1. XMPP stanza arrives.
2. Gateway stores message.
3. Wake policy evaluated.
4. Container started if necessary.
5. Runner resumes NanoClaw.
6. Runner injects normalized inbound event.
7. NanoClaw reasons.
8. NanoClaw invokes MCP tools.
9. Gateway translates MCP into XMPP.
10. Idle timeout stops container.

---

# 7. XEP Responsibilities

The gateway implements:

- XEP-0432
- XEP-0114
- XEP-0100
- XEP-0030
- XEP-0198
- XEP-0313
- XEP-0060
- XEP-0045
- XEP-0355
- XEP-0359
- XEP-0363
- XEP-0334
- XEP-0184
- XEP-0461
- XEP-0481

Agents implement none of them.

---

# 8. Message Model

This document intentionally does not redefine envelopes.

All inbound and outbound schemas are normative in the API Surface document.

The gateway acts as a protocol adapter only.

---

# 9. Wake Policy

Wake:

- direct human messages
- direct agent task requests
- mentions
- high-priority events

Batch:

- telemetry
- memory updates
- low-priority PubSub

---

# 10. Reliability

The gateway guarantees at-least-once delivery.

Mechanisms:

- durable mailbox
- leases
- retries
- idempotency
- XEP-0198
- stable stanza IDs

NanoClaw must treat inbound message IDs as idempotency keys.

---

# 11. Human Experience

Humans communicate using ordinary XMPP chat.

The gateway converts natural language into normalized inbound events.

Replies are rendered back into natural XMPP messages.

Humans never see JSON.

---

# 12. Agent Experience

Agents receive normalized events.

Agents send MCP tool calls.

They never construct XML.

They never reference XEP numbers.

---

# 13. Package Layout

```text
packages/

  agent-xmpp-gateway/
      XMPP implementation
      Docker lifecycle
      Mailbox
      Wake policy

  agent-xmpp-mcp/
      MCP server
      Tool implementations

  nanoclaw-runner/
      HTTP ingress
      JSONL ingress
      NanoClaw lifecycle

  protocol/
      Shared types imported from the API Surface package
```

---

# 14. Single Source of Truth

Protocol definitions:
- Agent XMPP Adapter API Surface

Gateway behavior:
- This specification

NanoClaw execution:
- NanoClaw integration specification

This separation avoids duplicated schemas and keeps protocol evolution independent of gateway implementation.
