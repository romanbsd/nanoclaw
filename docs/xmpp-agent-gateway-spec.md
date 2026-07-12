# XMPP Agent Gateway Specification

**Status:** Draft Architecture and Protocol Specification  
**Version:** 0.1.0  
**Date:** 2026-07-12  
**Intended implementation language:** TypeScript  
**Primary XMPP server:** Openfire  
**Container/runtime management:** External dependency; assumed to exist  
**Normative keywords:** The terms **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **SHOULD NOT**, and **MAY** are to be interpreted as described in RFC 2119 and RFC 8174.

---

## 1. Abstract

This document specifies an XMPP Agent Gateway that exposes structured APIs provided by logical LLM agents as Model Context Protocol (MCP) tools, while using XMPP for distributed identity, discovery, routing, durable task exchange, human-agent interaction, and agent-to-agent communication.

Each logical agent publishes an **Agent API Manifest**. The manifest contains MCP-compatible tool definitions, including names, descriptions, input schemas, output schemas, and annotations, plus agent-specific execution metadata such as progress, cancellation, clarification, authorization, and concurrency behavior.

The gateway:

1. represents each logical agent as an XMPP address;
2. integrates agent and operation metadata into XEP-0030 Service Discovery;
3. exposes authorized remote-agent operations to callers through an MCP server;
4. accepts MCP tool calls and translates them into durable XMPP task messages;
5. routes tasks to gateway-managed or externally connected agents;
6. delegates execution to a separately implemented runtime/container manager;
7. correlates task progress and results with the originating MCP request;
8. validates structured input and output against version-pinned JSON Schemas;
9. supports synchronous convenience calls over a durable asynchronous task model;
10. provides human-readable fallbacks and XEP-0004 forms where user input is required.

This specification deliberately separates three layers:

```text
MCP                 XMPP                       Runtime control
caller-facing API   distributed backbone      local agent execution
        │                    │                         │
        └── Gateway MCP ─────┴── Agent Gateway ──────┘
```

MCP is the semantic interface visible to an agent that calls another agent. XMPP is the identity, discovery, and transport backbone. Codex app-server, an OpenAI API harness, or another runtime-specific protocol is the private last mile between the gateway and the target agent runtime.

---

## 2. Scope

### 2.1 In scope

This specification covers:

- the XEP-0114 external component role of the gateway;
- logical agent identity and XMPP addressing;
- structured Agent API Manifests;
- XEP-0030 discovery of agents and virtual MCP endpoints;
- XEP-0128 extended discovery metadata;
- schema publication and retrieval;
- the gateway MCP server;
- dynamic MCP tool projection;
- explicit endpoint discovery tools;
- agent-to-agent structured calls;
- XMPP task, result, progress, input-required, and cancellation messages;
- synchronous and asynchronous invocation;
- interaction with dormant agents;
- integration boundaries for an external runtime manager;
- Codex app-server as one possible runtime adapter;
- structured completion;
- human clarification using XEP-0004;
- authorization, tenancy, credentials, validation, and audit;
- reliability, idempotency, retries, and failure behavior;
- registration, versioning, caching, and schema evolution;
- observability and operational requirements.

### 2.2 Out of scope

The following are assumed to be implemented elsewhere:

- container creation and destruction;
- image building and image distribution;
- filesystem and workspace mounting;
- resource quotas and cgroup configuration;
- sandbox implementation;
- model-provider account management;
- process supervision inside containers;
- long-term memory implementation;
- source-control checkout and synchronization;
- secret storage infrastructure;
- Openfire installation and base administration.

The gateway integrates with those capabilities through the runtime-manager contract defined in this document, but does not implement them.

### 2.3 Design goals

The design MUST satisfy the following goals:

1. **Structured agent APIs.** Every agent can publish strongly described operations with JSON Schema inputs and outputs.
2. **Natural MCP caller experience.** A calling agent sees remote capabilities as ordinary MCP tools.
3. **XMPP-native discovery.** Agent identities and APIs are discoverable through XEP-0030.
4. **Dormant-agent support.** An agent remains discoverable and callable when no container is running.
5. **Durable invocation.** A tool call is represented internally as a durable task, not a fragile long-lived RPC only.
6. **Provider independence.** The external API is not coupled to Codex app-server or any particular model provider.
7. **Tenant isolation.** Discovery and invocation results are authorization-filtered.
8. **Schema stability.** Running tasks remain bound to the schema version under which they were accepted.
9. **Human interoperability.** Agent messages can coexist with ordinary XMPP chat and can request structured human input.
10. **Minimal Openfire modification.** Unknown payloads are routed transparently where possible; server development is reserved for server-semantic requirements.

---

## 3. Terminology

### 3.1 Logical agent

A durable service identity that can provide one or more structured operations. A logical agent exists independently of any currently running process or container.

Example:

```text
security-reviewer@agents.acme.example
```

### 3.2 Agent runtime

A concrete process or container executing work for a logical agent. A runtime can be short-lived and may have a resource-qualified XMPP-like identity internally, but it does not need to connect directly to XMPP.

### 3.3 Agent API Manifest

A versioned document describing an agent and its callable operations. Operation definitions are compatible with MCP tool definitions and are extended with task-execution metadata.

### 3.4 Virtual MCP endpoint

The MCP-server-like representation of one logical XMPP agent. It has server metadata, capabilities, tools, XMPP routing metadata, authorization information, and availability information. It is virtual because the target agent need not host a physical MCP server or remain online.

### 3.5 Gateway MCP server

The physical MCP server exposed by the gateway to local or remote calling agents. It projects authorized virtual MCP endpoints and tools into one MCP connection.

### 3.6 Task

A durable invocation of one agent operation. A task has a globally unique ID, caller, target, operation, pinned API version, validated arguments, state, and optional structured result.

### 3.7 Runtime manager

An external service that ensures a target agent runtime exists, provides a runtime control channel, and reports lifecycle events. Its implementation is outside this specification.

### 3.8 Runtime adapter

A gateway module that translates a task into the control protocol of a particular agent harness, such as Codex app-server.

### 3.9 Calling agent

The agent that discovers and invokes another agent through MCP.

### 3.10 Target agent

The logical agent whose operation is invoked.

---

## 4. Architectural overview

### 4.1 Primary architecture

```text
┌──────────────────────┐
│ Calling Agent A      │
│ Codex / OpenAI loop  │
└──────────┬───────────┘
           │ MCP
           │ tools/list, tools/call
           ▼
┌──────────────────────────────────────────┐
│ XMPP Agent Gateway                       │
│                                          │
│  ┌────────────────────────────────────┐  │
│  │ MCP façade                        │  │
│  │ - endpoint discovery              │  │
│  │ - dynamic tool projection         │  │
│  │ - structured tool invocation      │  │
│  └───────────────┬────────────────────┘  │
│                  │                       │
│  ┌───────────────▼────────────────────┐  │
│  │ Agent registry and policy engine  │  │
│  │ - manifests and schema versions   │  │
│  │ - JID and node mapping            │  │
│  │ - tenant authorization            │  │
│  └───────────────┬────────────────────┘  │
│                  │                       │
│  ┌───────────────▼────────────────────┐  │
│  │ Task engine                       │  │
│  │ - durable state                   │  │
│  │ - correlation                    │  │
│  │ - retries and cancellation        │  │
│  └───────────────┬────────────────────┘  │
│                  │                       │
│  ┌───────────────▼────────────────────┐  │
│  │ XEP-0114 component                │  │
│  │ - routing                         │  │
│  │ - XEP-0030 discovery              │  │
│  │ - task/result stanzas             │  │
│  └───────────────┬────────────────────┘  │
└──────────────────┼───────────────────────┘
                   │ XMPP
                   ▼
             ┌──────────┐
             │ Openfire │
             └────┬─────┘
                  │
                  │ logical target JID
                  ▼
┌──────────────────────────────────────────┐
│ Gateway task dispatcher                  │
│ - receives/routs target task             │
│ - asks runtime manager to ensure runtime │
└──────────────────┬───────────────────────┘
                   │ runtime-manager API
                   ▼
┌──────────────────────────────────────────┐
│ Existing runtime/container manager       │
│ - wakes or restores target Agent B       │
│ - exposes runtime control channel        │
└──────────────────┬───────────────────────┘
                   │ Codex app-server,
                   │ OpenAI harness API,
                   │ or provider adapter
                   ▼
┌──────────────────────────────────────────┐
│ Target Agent B                           │
│ - receives operation as a turn           │
│ - calls gateway MCP tools                │
│ - completes task with structured result  │
└──────────────────────────────────────────┘
```

### 4.2 Logical MCP tunneling

The system implements **logical MCP tunneling**, not literal JSON-RPC frame tunneling.

```text
Agent A MCP call
    ↓
semantic operation invocation
    ↓
XMPP task
    ↓
target agent turn
    ↓
structured task result
    ↓
Agent A MCP result
```

The gateway MUST NOT expose XMPP routing details, Codex thread identifiers, container addresses, or runtime-specific control fields as ordinary business-operation arguments.

Literal MCP JSON-RPC messages MAY be transported for diagnostic or federation experiments, but this is not the normative invocation mechanism.

### 4.3 Why one physical MCP server

A single gateway MCP server provides:

- one authenticated connection per running agent;
- centralized authorization;
- dynamic projection of many virtual endpoints;
- no inbound network listener in target containers;
- no requirement for dormant agents to run MCP servers;
- one place to normalize schemas and task semantics;
- stable interfaces even if agent implementations change.

Each logical target agent nevertheless appears as a distinct **virtual MCP endpoint** in discovery results.

---

## 5. XMPP component

### 5.1 Component protocol

The gateway SHOULD connect to Openfire as an external component using XEP-0114.

Example component domain:

```text
agents.example.org
```

Logical agents are represented under that component domain:

```text
security-reviewer@agents.example.org
researcher@agents.example.org
deployment@agents.example.org
```

Depending on Openfire routing constraints, the implementation MAY instead allocate agents as component subdomains:

```text
security-reviewer.agents.example.org
researcher.agents.example.org
```

The bare-JID form is preferred where supported because it naturally represents agent identities and allows resources if needed.

### 5.2 Component responsibilities

The component MUST:

- authenticate to Openfire;
- accept stanzas addressed to the component and managed logical agent JIDs;
- route outbound stanzas with authorized `from` identities;
- answer supported `disco#info` and `disco#items` queries;
- route or process agent-task protocol payloads;
- reject spoofed or unauthorized logical-agent identities;
- preserve stanza correlation metadata;
- expose health and readiness separately from XMPP presence.

### 5.3 HA deployment

A production implementation SHOULD run multiple gateway replicas.

The component layer MUST ensure one of the following:

1. Openfire routes to a supported clustered component implementation;
2. a single active component connection is elected while other replicas remain standby;
3. the XMPP component connection is isolated in a dedicated routing service and task/MCP services scale independently.

Task state MUST NOT live only in the component process memory.

### 5.4 Component trust boundary

XEP-0114 component authentication gives the component broad authority under its domain. The gateway MUST therefore enforce:

- exact allowed `from` domains and JIDs;
- per-tenant logical identity ownership;
- operation authorization;
- schema registration authorization;
- stanza-size and payload limits;
- denial of arbitrary raw stanza injection by agent runtimes.

### 5.5 XEP-0355 and XEP-0356

Namespace Delegation and Privileged Entity capabilities MAY be used when the gateway must act on behalf of regular user domains or access server-side capabilities that are not naturally scoped to the component domain.

They SHOULD NOT be granted by default. The gateway SHOULD use the least privileged integration that satisfies the deployment.

---

## 6. Identity and addressing

### 6.1 Agent JIDs

Every registered agent MUST have one stable logical JID.

```text
<agent-localpart>@<component-domain>
```

Examples:

```text
security-reviewer@agents.acme.example
invoice-agent@agents.acme.example
researcher@agents.acme.example
```

Agent IDs SHOULD be lowercase, stable, and URL/JID safe. Display names belong in metadata, not the localpart.

### 6.2 Logical identity versus runtime identity

The bare JID identifies the logical agent. A running runtime MAY be represented internally as a resource:

```text
security-reviewer@agents.acme.example/run-01JZ8M...
```

However, the runtime is not required to connect to XMPP. The resource is a correlation concept that the gateway MAY expose for diagnostics or presence virtualization.

Calls MUST target the logical bare JID unless an explicitly runtime-specific operation is intended.

### 6.3 Caller identity

Every MCP session MUST be associated with a verified principal. For agent callers, the principal SHOULD map to an XMPP JID.

```text
developer-agent@agents.acme.example
```

The gateway MUST NOT trust a caller-supplied `from` JID in tool arguments. It derives the caller identity from the authenticated MCP session.

### 6.4 Human identities

Human users retain their regular XMPP JIDs. An agent task can originate from:

- another agent;
- a human in a direct chat;
- a human in a room;
- a scheduler;
- an external integration;
- an administrator.

The task envelope records the principal kind and original XMPP context.

### 6.5 Tenant and workspace scope

A JID alone is not necessarily sufficient for authorization. Every registered agent and task MUST be associated with a tenant. It MAY also be scoped to workspaces or server-side spaces.

Example:

```json
{
  "tenantId": "acme",
  "workspaceIds": ["engineering", "payments"]
}
```

The user has an existing Openfire implementation of XEP-0503 Server-side Spaces. The gateway MAY use those spaces as an authoritative source of workspace grouping and visibility, but this specification does not require XEP-0503 for the core protocol.

---

## 7. Agent API Manifest

### 7.1 Purpose

The Agent API Manifest is the canonical description of a logical agent's structured API. It is the source used to generate:

- XEP-0030 identities and operation nodes;
- XEP-0128 extended metadata;
- full schema responses;
- gateway MCP tool definitions;
- runtime operation prompts or invocation DTOs;
- task completion schemas;
- documentation and validation tests.

The manifest MUST describe business capabilities. It MUST NOT be generated directly from Codex app-server runtime-control methods.

### 7.2 Format

The canonical wire format is JSON. YAML MAY be accepted as an authoring format and converted to canonical JSON at registration.

The manifest MUST contain:

- manifest specification version;
- agent identity metadata;
- API version;
- capabilities;
- one or more operations;
- input schema for each operation;
- output schema where structured output is expected;
- execution and behavioral metadata.

### 7.3 Complete example

```json
{
  "$schema": "https://gateway.example/schemas/agent-api-manifest-1.json",
  "specVersion": "urn:businessos:agent-api:1",
  "agent": {
    "jid": "security-reviewer@agents.acme.example",
    "name": "security-reviewer",
    "title": "Security Reviewer",
    "description": "Reviews code, pull requests, and architecture for security risks.",
    "version": "1.4.0",
    "vendor": "Acme",
    "homepage": "https://internal.example/agents/security-reviewer",
    "icons": [
      {
        "src": "https://internal.example/icons/security-reviewer.svg",
        "mimeType": "image/svg+xml",
        "sizes": ["any"]
      }
    ]
  },
  "capabilities": {
    "tools": {
      "listChanged": true
    },
    "progress": true,
    "cancellation": true,
    "inputRequired": true,
    "structuredOutput": true
  },
  "operations": [
    {
      "name": "review_branch",
      "title": "Review Git branch",
      "description": "Review a Git branch for security vulnerabilities and return structured findings.",
      "inputSchema": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
          "repository": {
            "type": "string",
            "description": "Repository identifier visible to the target agent."
          },
          "branch": {
            "type": "string",
            "minLength": 1
          },
          "scope": {
            "type": "string",
            "enum": ["changed_files", "authentication", "complete"],
            "default": "changed_files"
          }
        },
        "required": ["repository", "branch"],
        "additionalProperties": false
      },
      "outputSchema": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
          "summary": {
            "type": "string"
          },
          "findings": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "severity": {
                  "type": "string",
                  "enum": ["info", "low", "medium", "high", "critical"]
                },
                "file": {
                  "type": "string"
                },
                "line": {
                  "type": "integer",
                  "minimum": 1
                },
                "description": {
                  "type": "string"
                },
                "recommendation": {
                  "type": "string"
                }
              },
              "required": ["severity", "description", "recommendation"],
              "additionalProperties": false
            }
          }
        },
        "required": ["summary", "findings"],
        "additionalProperties": false
      },
      "annotations": {
        "readOnlyHint": true,
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false
      },
      "execution": {
        "mode": "task",
        "supportsProgress": true,
        "supportsCancellation": true,
        "supportsInputRequired": true,
        "defaultTimeoutSeconds": 600,
        "maximumTimeoutSeconds": 1800,
        "estimatedDurationSeconds": 300,
        "concurrency": {
          "scope": "agent",
          "maximum": 4
        }
      },
      "authorization": {
        "requiredPermissions": [
          "agent.security-reviewer.review-branch"
        ],
        "approval": {
          "default": "none",
          "rules": [
            {
              "when": {
                "scope": "complete"
              },
              "require": "human"
            }
          ]
        }
      },
      "tags": ["security", "code-review", "git"]
    }
  ]
}
```

### 7.4 MCP compatibility

Each operation maps to an MCP Tool:

| Agent operation field | MCP tool field |
|---|---|
| `name` | `name` |
| `title` | `title` |
| `description` | `description` |
| `inputSchema` | `inputSchema` |
| `outputSchema` | `outputSchema` |
| `annotations` | `annotations` |
| vendor extensions | `_meta`, where appropriate |

Agent-specific fields such as execution duration, cancellation, authorization, and routing MUST be retained in the gateway registry but do not need to be exposed as standard MCP fields.

### 7.5 Schema restrictions

The implementation SHOULD support JSON Schema Draft 2020-12.

For interoperability with MCP clients, operation `inputSchema` MUST have an object root.

The gateway MUST enforce limits for:

- schema byte size;
- nesting depth;
- regular-expression complexity;
- number of properties;
- number and size of `$defs`;
- resolution of external `$ref` values;
- validation time.

External `$ref` values SHOULD be rejected or resolved only from an allowlisted schema registry during agent registration. Runtime validation MUST NOT perform unrestricted network fetches.

### 7.6 Build-time generation

Agent authors MAY generate manifests from strongly typed code.

Examples:

```text
Zod / TypeBox / Effect Schema
             ↓
        JSON Schema
             ↓
      agent-api.json
```

```text
Pydantic model
      ↓
JSON Schema
      ↓
agent-api.json
```

The gateway MUST validate the resulting canonical manifest independently.

### 7.7 Digesting

The gateway MUST canonicalize and hash:

- the full manifest;
- each operation input schema;
- each operation output schema.

Example identifiers:

```text
sha-256:84394c...
```

The digest is used for caching, task pinning, change detection, and audit.

---

## 8. Agent registration

### 8.1 Gateway-managed agents

For gateway-managed agents, registration happens before runtime activation.

```text
agent package installation
        ↓
read agent-api.json
        ↓
validate manifest
        ↓
verify JID ownership and tenant
        ↓
store version and schema digests
        ↓
index operation descriptions
        ↓
publish virtual XMPP discovery
        ↓
refresh MCP catalog
```

The agent remains discoverable while dormant.

### 8.2 External agents

An independently connected agent MAY publish or update a manifest through a custom registration IQ.

```xml
<iq type="set"
    from="security-reviewer@agents.partner.example/runtime"
    to="agents.example.org"
    id="register-1">
  <register xmlns="urn:businessos:agent-api:1">
    <manifest media-type="application/json">
      {
        "specVersion": "urn:businessos:agent-api:1",
        "agent": { "...": "..." },
        "operations": [ "..."]
      }
    </manifest>
  </register>
</iq>
```

The gateway MUST verify:

- authenticated sender identity;
- authority to register the declared JID;
- namespace and tenant policy;
- schema safety;
- version policy;
- operation-name uniqueness.

### 8.3 Registration result

```xml
<iq type="result"
    from="agents.example.org"
    to="security-reviewer@agents.partner.example/runtime"
    id="register-1">
  <registered xmlns="urn:businessos:agent-api:1"
              jid="security-reviewer@agents.partner.example"
              version="1.4.0"
              manifest-digest="sha-256:4e71..."/>
</iq>
```

### 8.4 Updates

A new manifest version does not mutate old task contracts. The registry MUST retain referenced historical versions while any task or audit-retention rule depends on them.

A successful update SHOULD trigger:

- registry index refresh;
- XEP-0030 cache invalidation;
- endpoint catalog change event;
- MCP `tools/list_changed` notification where supported.

---

## 9. XEP-0030 discovery model

### 9.1 Principles

XEP-0030 provides two mechanisms:

- `disco#info`: identity and supported features;
- `disco#items`: child or associated items.

The gateway uses them as follows:

```text
gateway component
    └── list visible agents

logical agent JID
    ├── describe virtual MCP endpoint
    └── list operation nodes

logical agent JID + operation node
    └── describe one MCP-compatible tool
```

Full JSON Schemas are retrieved through the custom Agent API IQ or a content-addressed resource. They SHOULD NOT be embedded wholesale in XEP-0030 unless very small.

### 9.2 Namespace constants

Recommended namespaces:

```text
urn:businessos:agent-directory:1
urn:businessos:agent-api:1
urn:businessos:agent-operation:1
urn:businessos:agent-task:1
urn:businessos:agent-task:progress:1
urn:businessos:agent-task:cancel:1
urn:businessos:agent-task:input-required:1
urn:businessos:mcp-endpoint:1
urn:businessos:mcp-tool-info:1
```

These are private experimental namespaces. A future standardization effort SHOULD use an appropriate permanent XMPP namespace.

### 9.3 Gateway discovery

Request:

```xml
<iq type="get"
    from="developer-agent@agents.acme.example/run-a"
    to="agents.acme.example"
    id="gateway-info-1">
  <query xmlns="http://jabber.org/protocol/disco#info"/>
</iq>
```

Response:

```xml
<iq type="result"
    from="agents.acme.example"
    to="developer-agent@agents.acme.example/run-a"
    id="gateway-info-1">
  <query xmlns="http://jabber.org/protocol/disco#info">
    <identity
        category="automation"
        type="agent-gateway"
        name="Acme Agent Gateway"/>

    <feature var="http://jabber.org/protocol/disco#info"/>
    <feature var="http://jabber.org/protocol/disco#items"/>
    <feature var="urn:businessos:agent-directory:1"/>
    <feature var="urn:businessos:agent-api:1"/>
    <feature var="urn:businessos:agent-task:1"/>
    <feature var="urn:businessos:mcp-endpoint:1"/>
  </query>
</iq>
```

The `automation` identity category and agent-specific types are application conventions until standardized.

### 9.4 Listing visible agents

Request:

```xml
<iq type="get"
    from="developer-agent@agents.acme.example/run-a"
    to="agents.acme.example"
    id="list-agents-1">
  <query xmlns="http://jabber.org/protocol/disco#items"
         node="urn:businessos:agent-directory:1"/>
</iq>
```

Response:

```xml
<iq type="result"
    from="agents.acme.example"
    to="developer-agent@agents.acme.example/run-a"
    id="list-agents-1">
  <query xmlns="http://jabber.org/protocol/disco#items"
         node="urn:businessos:agent-directory:1">

    <item jid="security-reviewer@agents.acme.example"
          node="urn:businessos:mcp-endpoint:1"
          name="Security Reviewer"/>

    <item jid="researcher@agents.acme.example"
          node="urn:businessos:mcp-endpoint:1"
          name="Research Agent"/>
  </query>
</iq>
```

The gateway MUST authorization-filter results. An unauthorized agent MUST NOT appear merely as non-invocable unless policy intentionally allows discoverable-but-not-callable services.

### 9.5 Describing an agent endpoint

Request:

```xml
<iq type="get"
    from="developer-agent@agents.acme.example/run-a"
    to="security-reviewer@agents.acme.example"
    id="agent-info-1">
  <query xmlns="http://jabber.org/protocol/disco#info"
         node="urn:businessos:mcp-endpoint:1"/>
</iq>
```

Response:

```xml
<iq type="result"
    from="security-reviewer@agents.acme.example"
    to="developer-agent@agents.acme.example/run-a"
    id="agent-info-1">
  <query xmlns="http://jabber.org/protocol/disco#info"
         node="urn:businessos:mcp-endpoint:1">

    <identity
        category="automation"
        type="mcp-endpoint"
        name="Security Reviewer"/>

    <feature var="urn:businessos:mcp-endpoint:1"/>
    <feature var="urn:businessos:agent-api:1"/>
    <feature var="urn:businessos:agent-task:1"/>
    <feature var="urn:businessos:agent-task:progress:1"/>
    <feature var="urn:businessos:agent-task:cancel:1"/>
    <feature var="urn:businessos:agent-task:input-required:1"/>

    <x xmlns="jabber:x:data" type="result">
      <field var="FORM_TYPE" type="hidden">
        <value>urn:businessos:mcp-endpoint-info:1</value>
      </field>
      <field var="endpoint_id">
        <value>xmpp+mcp://security-reviewer@agents.acme.example</value>
      </field>
      <field var="server_name">
        <value>security-reviewer</value>
      </field>
      <field var="server_title">
        <value>Security Reviewer</value>
      </field>
      <field var="description">
        <value>Reviews code and architecture for security risks.</value>
      </field>
      <field var="version">
        <value>1.4.0</value>
      </field>
      <field var="manifest_digest">
        <value>sha-256:4e71...</value>
      </field>
      <field var="availability">
        <value>dormant</value>
      </field>
      <field var="cold_start_supported">
        <value>true</value>
      </field>
    </x>
  </query>
</iq>
```

The XEP-0004 result form follows the XEP-0128 pattern for extended service-discovery information.

### 9.6 Listing operations

Request:

```xml
<iq type="get"
    from="developer-agent@agents.acme.example/run-a"
    to="security-reviewer@agents.acme.example"
    id="agent-tools-1">
  <query xmlns="http://jabber.org/protocol/disco#items"
         node="urn:businessos:agent-api:1"/>
</iq>
```

Response:

```xml
<iq type="result"
    from="security-reviewer@agents.acme.example"
    to="developer-agent@agents.acme.example/run-a"
    id="agent-tools-1">
  <query xmlns="http://jabber.org/protocol/disco#items"
         node="urn:businessos:agent-api:1">

    <item jid="security-reviewer@agents.acme.example"
          node="urn:businessos:agent-operation:1#review_branch"
          name="Review Git branch"/>

    <item jid="security-reviewer@agents.acme.example"
          node="urn:businessos:agent-operation:1#review_pull_request"
          name="Review pull request"/>

    <item jid="security-reviewer@agents.acme.example"
          node="urn:businessos:agent-operation:1#threat_model"
          name="Create threat model"/>
  </query>
</iq>
```

Operation names MUST be encoded safely in node identifiers. The normative operation name remains in metadata and MUST NOT be inferred only from the node string.

### 9.7 Describing an operation

Request:

```xml
<iq type="get"
    from="developer-agent@agents.acme.example/run-a"
    to="security-reviewer@agents.acme.example"
    id="tool-info-1">
  <query xmlns="http://jabber.org/protocol/disco#info"
         node="urn:businessos:agent-operation:1#review_branch"/>
</iq>
```

Response:

```xml
<iq type="result"
    from="security-reviewer@agents.acme.example"
    to="developer-agent@agents.acme.example/run-a"
    id="tool-info-1">
  <query xmlns="http://jabber.org/protocol/disco#info"
         node="urn:businessos:agent-operation:1#review_branch">

    <identity
        category="automation"
        type="mcp-tool"
        name="Review Git branch"/>

    <feature var="urn:businessos:agent-operation:1"/>
    <feature var="urn:businessos:agent-task:progress:1"/>
    <feature var="urn:businessos:agent-task:cancel:1"/>
    <feature var="urn:businessos:agent-task:input-required:1"/>

    <x xmlns="jabber:x:data" type="result">
      <field var="FORM_TYPE" type="hidden">
        <value>urn:businessos:mcp-tool-info:1</value>
      </field>

      <field var="name">
        <value>review_branch</value>
      </field>
      <field var="title">
        <value>Review Git branch</value>
      </field>
      <field var="description">
        <value>Review a Git branch for security vulnerabilities.</value>
      </field>
      <field var="api_version">
        <value>1.4.0</value>
      </field>

      <field var="input_schema_uri">
        <value>xmpp+agent-schema://security-reviewer@agents.acme.example/review_branch/input?version=1.4.0</value>
      </field>
      <field var="input_schema_digest">
        <value>sha-256:84394c...</value>
      </field>

      <field var="output_schema_uri">
        <value>xmpp+agent-schema://security-reviewer@agents.acme.example/review_branch/output?version=1.4.0</value>
      </field>
      <field var="output_schema_digest">
        <value>sha-256:1134ab...</value>
      </field>

      <field var="read_only">
        <value>true</value>
      </field>
      <field var="destructive">
        <value>false</value>
      </field>
      <field var="idempotent">
        <value>true</value>
      </field>
      <field var="open_world">
        <value>false</value>
      </field>

      <field var="estimated_duration_seconds">
        <value>300</value>
      </field>
      <field var="maximum_timeout_seconds">
        <value>1800</value>
      </field>
    </x>
  </query>
</iq>
```

### 9.8 Complete endpoint descriptor

XEP-0030 is canonical for distributed discovery, but callers should receive a complete MCP-oriented descriptor from the gateway.

Example:

```json
{
  "endpointId": "xmpp+mcp://security-reviewer@agents.acme.example",
  "transport": {
    "kind": "xmpp-gateway",
    "gateway": "agents.acme.example"
  },
  "server": {
    "name": "security-reviewer",
    "title": "Security Reviewer",
    "description": "Reviews code and architecture for security risks.",
    "version": "1.4.0",
    "icons": []
  },
  "capabilities": {
    "tools": {
      "listChanged": true
    },
    "progress": true,
    "cancellation": true,
    "inputRequired": true
  },
  "xmpp": {
    "jid": "security-reviewer@agents.acme.example",
    "endpointNode": "urn:businessos:mcp-endpoint:1",
    "toolsNode": "urn:businessos:agent-api:1",
    "features": [
      "urn:businessos:agent-task:1",
      "urn:businessos:agent-task:progress:1",
      "urn:businessos:agent-task:cancel:1"
    ]
  },
  "authorization": {
    "visible": true,
    "invocable": true,
    "approvalRequired": false
  },
  "availability": {
    "state": "dormant",
    "coldStartSupported": true,
    "estimatedColdStartSeconds": 4
  },
  "tools": [
    {
      "name": "review_branch",
      "title": "Review Git branch",
      "description": "Review a Git branch for security vulnerabilities.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "repository": {"type": "string"},
          "branch": {"type": "string"}
        },
        "required": ["repository", "branch"],
        "additionalProperties": false
      },
      "outputSchema": {
        "type": "object",
        "properties": {
          "summary": {"type": "string"},
          "findings": {"type": "array"}
        },
        "required": ["summary", "findings"]
      },
      "annotations": {
        "readOnlyHint": true,
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false
      },
      "_meta": {
        "businessos/routing": {
          "jid": "security-reviewer@agents.acme.example",
          "node": "urn:businessos:agent-operation:1#review_branch",
          "apiVersion": "1.4.0",
          "inputSchemaDigest": "sha-256:84394c...",
          "outputSchemaDigest": "sha-256:1134ab..."
        },
        "businessos/execution": {
          "mode": "task",
          "supportsProgress": true,
          "supportsCancellation": true,
          "supportsInputRequired": true,
          "estimatedDurationSeconds": 300
        }
      }
    }
  ]
}
```

### 9.9 Semantic search

XEP-0030 is hierarchical discovery, not semantic search. The gateway SHOULD index:

- agent title and description;
- operation title and description;
- tags;
- schema property names and descriptions;
- workspace scope;
- permissions;
- optional cost, latency, and reliability signals.

An explicit MCP discovery tool can query this index and return canonical endpoint descriptors. Every result MUST retain the XMPP JID, operation node, API version, and schema digests.

---

## 10. Schema retrieval protocol

### 10.1 Request

```xml
<iq type="get"
    from="developer-agent@agents.acme.example/run-a"
    to="security-reviewer@agents.acme.example"
    id="schema-1">
  <schema xmlns="urn:businessos:agent-api:1"
          operation="review_branch"
          version="1.4.0"
          direction="input"/>
</iq>
```

### 10.2 Inline response

```xml
<iq type="result"
    from="security-reviewer@agents.acme.example"
    to="developer-agent@agents.acme.example/run-a"
    id="schema-1">
  <schema xmlns="urn:businessos:agent-api:1"
          operation="review_branch"
          version="1.4.0"
          direction="input"
          media-type="application/schema+json"
          digest="sha-256:84394c...">
    {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "properties": {
        "repository": {"type": "string"},
        "branch": {"type": "string"}
      },
      "required": ["repository", "branch"],
      "additionalProperties": false
    }
  </schema>
</iq>
```

### 10.3 Referenced response

Large schemas MAY be returned by reference:

```xml
<iq type="result"
    from="security-reviewer@agents.acme.example"
    to="developer-agent@agents.acme.example/run-a"
    id="schema-1">
  <schema xmlns="urn:businessos:agent-api:1"
          operation="review_branch"
          version="1.4.0"
          direction="input"
          media-type="application/schema+json"
          digest="sha-256:84394c..."
          href="https://gateway.acme.example/schemas/sha256/84394c..."/>
</iq>
```

The referenced resource MUST be immutable for the digest. Access MUST use caller-appropriate authorization or a short-lived signed URL.

### 10.4 Error cases

The gateway SHOULD return standard XMPP errors:

| Condition | XMPP error |
|---|---|
| Agent unknown | `item-not-found` |
| Operation unknown | `item-not-found` |
| Version unknown | `item-not-found` |
| Unauthorized | `forbidden` |
| Direction invalid | `bad-request` |
| Schema too large for inline response | return reference, or `resource-constraint` |
| Temporary registry issue | `service-unavailable` |

---

## 11. Gateway MCP server

### 11.1 Role

The gateway exposes one MCP server to calling agents. It has two complementary interfaces:

1. **Projected tools:** selected remote operations appear as directly callable MCP tools.
2. **Directory tools:** generic tools discover endpoints and invoke operations by endpoint and tool name.

### 11.2 MCP server metadata

Example initialization metadata:

```json
{
  "protocolVersion": "2025-11-25",
  "serverInfo": {
    "name": "businessos-xmpp-agent-gateway",
    "title": "BusinessOS XMPP Agent Gateway",
    "version": "0.1.0"
  },
  "capabilities": {
    "tools": {
      "listChanged": true
    },
    "logging": {}
  }
}
```

The exact MCP protocol version MUST be negotiated according to the MCP implementation in use.

### 11.3 Projected tool naming

Names MUST be unique within one MCP `tools/list` result.

Recommended deterministic format:

```text
<agent-slug>__<operation-name>
```

Examples:

```text
security_reviewer__review_branch
researcher__search_sources
deployment__deploy_service
```

If a name exceeds client limits, the gateway MAY use a stable abbreviated prefix and retain full routing metadata in `_meta`.

Tool names are a convenience projection, not canonical identity. Canonical identity is:

```text
endpoint ID + operation name + API version
```

### 11.4 Projected tool example

```json
{
  "name": "security_reviewer__review_branch",
  "title": "Security Reviewer: Review Git branch",
  "description": "Ask the Security Reviewer agent to review a Git branch for security vulnerabilities.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "repository": {"type": "string"},
      "branch": {"type": "string"},
      "scope": {
        "type": "string",
        "enum": ["changed_files", "authentication", "complete"]
      }
    },
    "required": ["repository", "branch"],
    "additionalProperties": false
  },
  "outputSchema": {
    "type": "object",
    "properties": {
      "summary": {"type": "string"},
      "findings": {"type": "array"}
    },
    "required": ["summary", "findings"]
  },
  "annotations": {
    "readOnlyHint": true,
    "destructiveHint": false,
    "idempotentHint": true,
    "openWorldHint": false
  },
  "_meta": {
    "businessos/endpointId": "xmpp+mcp://security-reviewer@agents.acme.example",
    "businessos/operation": "review_branch",
    "businessos/apiVersion": "1.4.0",
    "businessos/inputSchemaDigest": "sha-256:84394c...",
    "businessos/outputSchemaDigest": "sha-256:1134ab..."
  }
}
```

### 11.5 Dynamic visibility

`tools/list` MUST be generated from:

```text
registered operations
× authenticated caller
× tenant
× workspace/space membership
× target policy
× operation policy
× gateway policy
```

A tool removed from a later `tools/list` MUST NOT invalidate an already accepted task. It prevents future calls.

### 11.6 Catalog size strategy

Projecting every operation from every agent can consume excessive model context. The gateway SHOULD support configurable strategies:

- project all visible tools for small deployments;
- project only pinned/favorite agents;
- project only tools relevant to current workspace;
- project a small set of directory tools and dynamically load endpoint-specific tools;
- use semantic discovery followed by generic `agents.call_tool`.

### 11.7 Directory tools

Recommended built-in MCP tools:

```text
agents.discover_endpoints
agents.describe_endpoint
agents.list_tools
agents.call_tool
agents.start_tool
agents.get_task
agents.get_result
agents.cancel_task
agents.answer_input
```

#### `agents.discover_endpoints`

```json
{
  "name": "agents.discover_endpoints",
  "description": "Find authorized virtual MCP endpoints and tools provided by other agents.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "query": {
        "type": "string",
        "description": "Natural-language description of the needed capability."
      },
      "agent": {
        "type": "string",
        "description": "Optional agent JID or name filter."
      },
      "tags": {
        "type": "array",
        "items": {"type": "string"}
      },
      "workspace": {
        "type": "string"
      },
      "includeTools": {
        "type": "boolean",
        "default": true
      },
      "includeSchemas": {
        "type": "boolean",
        "default": true
      },
      "limit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 50,
        "default": 10
      }
    },
    "required": ["query"],
    "additionalProperties": false
  }
}
```

The result MUST be a list of complete virtual MCP endpoint descriptors, not only names.

#### `agents.call_tool`

```json
{
  "name": "agents.call_tool",
  "description": "Invoke a tool on a virtual MCP endpoint and wait for its result.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "endpointId": {"type": "string"},
      "tool": {"type": "string"},
      "arguments": {
        "type": "object",
        "additionalProperties": true
      },
      "apiVersion": {"type": "string"},
      "timeoutSeconds": {
        "type": "integer",
        "minimum": 1
      },
      "idempotencyKey": {"type": "string"}
    },
    "required": ["endpointId", "tool", "arguments"],
    "additionalProperties": false
  }
}
```

Because the tool's argument schema is dynamic, projected tools provide stronger static typing. `agents.call_tool` MUST look up and validate the referenced operation schema before task creation.

#### `agents.start_tool`

This is the asynchronous equivalent and returns a task handle immediately.

```json
{
  "taskId": "task-01JZ8M...",
  "status": "accepted",
  "endpointId": "xmpp+mcp://security-reviewer@agents.acme.example",
  "tool": "review_branch"
}
```

### 11.8 Result shape

For an operation with `outputSchema`, a completed MCP tool result SHOULD return both:

- normal MCP content suitable for display;
- `structuredContent` that conforms to the output schema.

Conceptual result:

```json
{
  "content": [
    {
      "type": "text",
      "text": "The security review completed with two findings."
    }
  ],
  "structuredContent": {
    "summary": "Two authentication issues were identified.",
    "findings": [
      {
        "severity": "high",
        "description": "The challenge can be reused.",
        "recommendation": "Consume challenges atomically."
      }
    ]
  },
  "_meta": {
    "businessos/taskId": "task-01JZ8M...",
    "businessos/target": "security-reviewer@agents.acme.example"
  }
}
```

---

## 12. Agent task protocol over XMPP

### 12.1 Transport choice

The gateway MUST use message stanzas for long-running task lifecycle operations.

IQ is appropriate for:

- discovery;
- manifest registration;
- schema retrieval;
- short administrative queries.

IQ SHOULD NOT represent the complete lifecycle of an LLM operation that may take minutes, need clarification, survive a restart, or continue asynchronously.

### 12.2 Payload encoding

Task metadata is expressed in XML attributes and elements. Structured arguments and results are JSON.

Example:

```xml
<arguments media-type="application/json">
  {"repository":"payments-api","branch":"feature/passkeys"}
</arguments>
```

The implementation MAY wrap JSON using XEP-0432 Simple JSON Messaging conventions. Openfire does not need special logic merely to route an unknown namespaced payload.

### 12.3 Identifiers

Every task MUST have:

- `task-id`: globally unique durable task ID;
- XMPP message `id`;
- XEP-0359 `origin-id`, where supported;
- caller correlation ID for MCP request correlation;
- operation name;
- pinned API version;
- input and output schema digests.

Recommended IDs are UUIDv7 or ULID-like sortable identifiers.

### 12.4 Invocation message

```xml
<message
    from="developer-agent@agents.acme.example"
    to="security-reviewer@agents.acme.example"
    type="normal"
    id="msg-01JZ8M1">

  <origin-id xmlns="urn:xmpp:sid:0"
             id="origin-01JZ8M1"/>

  <invoke xmlns="urn:businessos:agent-task:1"
          task-id="task-01JZ8M0"
          correlation-id="mcp-call-938"
          operation="review_branch"
          api-version="1.4.0"
          input-schema-digest="sha-256:84394c..."
          output-schema-digest="sha-256:1134ab..."
          response-mode="deferred">

    <caller
        jid="developer-agent@agents.acme.example"
        kind="agent"/>

    <context
        tenant-id="acme"
        workspace-id="engineering"
        conversation-id="xmpp:dm:developer-agent:security-reviewer"/>

    <arguments media-type="application/json">
      {
        "repository": "payments-api",
        "branch": "feature/passkeys",
        "scope": "authentication"
      }
    </arguments>

    <deadline>2026-07-12T15:30:00Z</deadline>
  </invoke>

  <request xmlns="urn:xmpp:receipts"/>
</message>
```

### 12.5 Human-readable fallback

When a stanza may reach a human client, it SHOULD include a `<body>` fallback:

```xml
<body>
  The developer agent requested operation “Review Git branch”
  from Security Reviewer. Task: task-01JZ8M0.
</body>
```

For internal component-to-component messages, the body MAY be omitted.

### 12.6 Acceptance

Acceptance means the task is durably recorded and authorized. It does not necessarily mean a runtime is already running.

```xml
<message
    from="security-reviewer@agents.acme.example"
    to="developer-agent@agents.acme.example"
    type="normal"
    id="ack-01JZ8M2">

  <accepted xmlns="urn:businessos:agent-task:1"
            task-id="task-01JZ8M0"
            correlation-id="mcp-call-938"
            accepted-at="2026-07-12T15:20:03Z"/>
</message>
```

### 12.7 Progress

```xml
<message
    from="security-reviewer@agents.acme.example"
    to="developer-agent@agents.acme.example"
    type="normal"
    id="progress-01JZ8M3">

  <progress xmlns="urn:businessos:agent-task:1"
            task-id="task-01JZ8M0"
            sequence="3"
            percent="45"
            stage="analysis">
    <message>Reviewing authentication challenge lifecycle.</message>
  </progress>
</message>
```

Progress is advisory. Missing progress events MUST NOT imply failure.

### 12.8 Completion

```xml
<message
    from="security-reviewer@agents.acme.example"
    to="developer-agent@agents.acme.example"
    type="normal"
    id="result-01JZ8M4">

  <result xmlns="urn:businessos:agent-task:1"
          task-id="task-01JZ8M0"
          correlation-id="mcp-call-938"
          operation="review_branch"
          api-version="1.4.0"
          output-schema-digest="sha-256:1134ab..."
          status="completed">

    <content media-type="application/json">
      {
        "summary": "Two authentication issues were identified.",
        "findings": [
          {
            "severity": "high",
            "file": "src/auth/passkey.ts",
            "line": 142,
            "description": "The challenge can be reused.",
            "recommendation": "Mark the challenge consumed atomically."
          }
        ]
      }
    </content>
  </result>
</message>
```

The gateway MUST validate the result against the pinned output schema before completing the MCP call.

### 12.9 Failure

```xml
<message
    from="security-reviewer@agents.acme.example"
    to="developer-agent@agents.acme.example"
    type="normal"
    id="failure-01JZ8M5">

  <result xmlns="urn:businessos:agent-task:1"
          task-id="task-01JZ8M0"
          correlation-id="mcp-call-938"
          status="failed">

    <error code="repository-unavailable"
           retryable="true">
      <message>The repository could not be mounted.</message>
      <details media-type="application/json">
        {"repository":"payments-api"}
      </details>
    </error>
  </result>
</message>
```

### 12.10 Cancellation request

```xml
<message
    from="developer-agent@agents.acme.example"
    to="security-reviewer@agents.acme.example"
    type="normal"
    id="cancel-01JZ8M6">

  <cancel xmlns="urn:businessos:agent-task:1"
          task-id="task-01JZ8M0"
          reason="Caller no longer needs the result"/>
</message>
```

### 12.11 Cancellation result

```xml
<message
    from="security-reviewer@agents.acme.example"
    to="developer-agent@agents.acme.example"
    type="normal"
    id="cancelled-01JZ8M7">

  <result xmlns="urn:businessos:agent-task:1"
          task-id="task-01JZ8M0"
          status="cancelled"/>
</message>
```

Cancellation is cooperative. The gateway MUST distinguish:

- cancellation requested;
- runtime interruption requested;
- task actually cancelled;
- task completed before cancellation took effect.

### 12.12 Clarification required

```xml
<message
    from="security-reviewer@agents.acme.example"
    to="developer-agent@agents.acme.example"
    type="normal"
    id="input-01JZ8M8">

  <input-required xmlns="urn:businessos:agent-task:1"
                  task-id="task-01JZ8M0"
                  request-id="input-1">

    <question>
      Should the review cover changed files only or the complete
      authentication subsystem?
    </question>

    <input-schema media-type="application/schema+json">
      {
        "type": "object",
        "properties": {
          "scope": {
            "type": "string",
            "enum": ["changed_files", "complete"]
          }
        },
        "required": ["scope"],
        "additionalProperties": false
      }
    </input-required>
</message>
```

### 12.13 Clarification answer

```xml
<message
    from="developer-agent@agents.acme.example"
    to="security-reviewer@agents.acme.example"
    type="normal"
    id="answer-01JZ8M9">

  <input xmlns="urn:businessos:agent-task:1"
         task-id="task-01JZ8M0"
         request-id="input-1">

    <content media-type="application/json">
      {"scope":"complete"}
    </content>
  </input>
</message>
```

### 12.14 XEP-0004 rendering for humans

When clarification is routed to a human XMPP client, the gateway SHOULD additionally generate a XEP-0004 form.

```xml
<message
    from="security-reviewer@agents.acme.example"
    to="roman@acme.example"
    type="chat"
    id="human-input-1">

  <body>
    The Security Reviewer needs clarification for task task-01JZ8M0.
  </body>

  <x xmlns="jabber:x:data" type="form">
    <title>Security review scope</title>
    <instructions>
      Choose how broadly the authentication code should be reviewed.
    </instructions>

    <field var="FORM_TYPE" type="hidden">
      <value>urn:businessos:agent-task-input:1</value>
    </field>
    <field var="task_id" type="hidden">
      <value>task-01JZ8M0</value>
    </field>
    <field var="request_id" type="hidden">
      <value>input-1</value>
    </field>

    <field var="scope"
           type="list-single"
           label="Review scope">
      <required/>
      <option label="Changed files only">
        <value>changed_files</value>
      </option>
      <option label="Complete authentication subsystem">
        <value>complete</value>
      </option>
    </field>
  </x>
</message>
```

The canonical machine schema remains JSON Schema. XEP-0004 is a derived human presentation for representable schemas.

---

## 13. Task state machine

### 13.1 States

```text
CREATED
   ↓
VALIDATING
   ├──→ REJECTED
   ↓
ACCEPTED
   ↓
QUEUED
   ↓
STARTING
   ↓
RUNNING
   ├──→ INPUT_REQUIRED ──→ RUNNING
   ├──→ CANCELLING ─────→ CANCELLED
   ├──→ FAILED
   ├──→ TIMED_OUT
   └──→ COMPLETED
```

### 13.2 State meanings

| State | Meaning |
|---|---|
| `CREATED` | Request received but not yet validated |
| `VALIDATING` | Authorization and schema validation in progress |
| `REJECTED` | Never accepted; permanent validation/policy failure |
| `ACCEPTED` | Durably recorded and authorized |
| `QUEUED` | Waiting for runtime/concurrency capacity |
| `STARTING` | Runtime manager is starting or restoring the target |
| `RUNNING` | Target agent is actively processing |
| `INPUT_REQUIRED` | Waiting for caller or human input |
| `CANCELLING` | Cancellation requested but not terminal |
| `CANCELLED` | Terminal cancellation |
| `FAILED` | Terminal execution failure |
| `TIMED_OUT` | Deadline exceeded |
| `COMPLETED` | Valid structured result committed |

### 13.3 Terminal states

```text
REJECTED
CANCELLED
FAILED
TIMED_OUT
COMPLETED
```

A terminal state MUST NOT transition to another state. A retry creates a new execution attempt and, depending on policy, either the same durable task with an incremented attempt number or a new child task.

---

## 14. Synchronous and asynchronous MCP calls

### 14.1 Durable core

Every invocation MUST create a durable task even when the caller uses a synchronous projected tool.

### 14.2 Synchronous convenience

For a normal MCP tool call:

```text
tools/call
   ↓
create durable task
   ↓
wait for terminal result
   ↓
return MCP result
```

The gateway SHOULD stream or report MCP progress when supported.

If the MCP transport disconnects, the task SHOULD continue unless:

- the caller explicitly requested cancel-on-disconnect;
- policy says ephemeral;
- an explicit cancellation is received.

### 14.3 Asynchronous call

`agents.start_tool` returns a task ID after acceptance. The caller later uses:

```text
agents.get_task
agents.get_result
agents.cancel_task
agents.answer_input
```

### 14.4 Timeout semantics

The following timeouts are distinct:

- MCP request wait timeout;
- task deadline;
- runtime startup timeout;
- individual execution attempt timeout;
- clarification response timeout.

An MCP wait timeout MUST NOT automatically mark the durable task as failed.

### 14.5 Idempotency

Callers SHOULD provide an idempotency key for operations that may be retried.

The gateway computes an idempotency scope from:

```text
caller principal
+ endpoint ID
+ operation
+ API version
+ idempotency key
```

If the same scoped key is received again, the gateway SHOULD return the existing task or terminal result rather than execute a duplicate.

The target operation's `idempotentHint` is informative. It does not replace gateway idempotency handling.

---

## 15. Runtime-manager integration

### 15.1 Boundary

The runtime manager is already implemented elsewhere. The gateway uses it through a provider-neutral contract.

The gateway MUST NOT assume that a logical agent is continuously reachable through HTTP, WebSocket, or MCP.

### 15.2 Required runtime-manager operations

Conceptual interface:

```typescript
interface AgentRuntimeManager {
  ensureRuntime(request: EnsureRuntimeRequest): Promise<RuntimeHandle>;
  getRuntime(agentJid: string): Promise<RuntimeHandle | null>;
  interrupt(request: InterruptRuntimeRequest): Promise<void>;
  release(request: ReleaseRuntimeRequest): Promise<void>;
}
```

```typescript
interface EnsureRuntimeRequest {
  tenantId: string;
  agentJid: string;
  taskId: string;
  apiVersion: string;
  operation: string;
  deadline?: string;
  requiredCapabilities?: string[];
  credentialGrant: RuntimeCredentialGrant;
}
```

```typescript
interface RuntimeHandle {
  runtimeId: string;
  agentJid: string;
  provider: "codex-app-server" | "openai-api" | "custom";
  controlEndpoint: RuntimeControlEndpoint;
  startedAt: string;
  resumed: boolean;
}
```

### 15.3 Runtime adapter interface

```typescript
interface AgentRuntimeAdapter {
  invoke(
    runtime: RuntimeHandle,
    invocation: RuntimeInvocation,
    events: RuntimeEventSink
  ): Promise<RuntimeInvocationResult>;

  provideInput(
    runtime: RuntimeHandle,
    taskId: string,
    requestId: string,
    input: unknown
  ): Promise<void>;

  cancel(
    runtime: RuntimeHandle,
    taskId: string,
    reason?: string
  ): Promise<void>;
}
```

### 15.4 Runtime invocation

```typescript
interface RuntimeInvocation {
  taskId: string;
  caller: {
    jid: string;
    kind: "agent" | "human" | "service";
  };
  agentJid: string;
  operation: {
    name: string;
    title: string;
    description: string;
    apiVersion: string;
    inputSchema: object;
    outputSchema?: object;
  };
  arguments: unknown;
  context: {
    tenantId: string;
    workspaceId?: string;
    conversationId?: string;
  };
  deadline?: string;
}
```

### 15.5 Runtime events

```typescript
type RuntimeEvent =
  | { type: "progress"; percent?: number; stage?: string; message?: string }
  | { type: "input_required"; requestId: string; question: string; inputSchema: object }
  | { type: "completed"; result: unknown; summary?: string }
  | { type: "failed"; code: string; message: string; retryable: boolean }
  | { type: "cancelled" };
```

The gateway validates and converts these into XMPP task lifecycle messages and MCP notifications/results.

---

## 16. Codex app-server adapter

### 16.1 Role

Codex app-server is a runtime control protocol. It is not the agent's public structured API.

The adapter uses Codex app-server to:

- initialize a Codex runtime;
- start or resume a thread;
- start a turn;
- observe streamed events;
- respond to approval requests according to policy;
- interrupt a turn;
- obtain completion or failure.

The adapter SHOULD generate client types from the installed Codex version rather than hard-code unstable method schemas.

### 16.2 Thread mapping

Recommended thread key:

```text
tenant ID
+ target agent JID
+ conversation scope
```

Possible policies:

| Invocation type | Thread policy |
|---|---|
| independent one-off operation | new thread per task |
| repeated collaboration between two agents | thread per pair and project |
| room-based operation | thread per room |
| sensitive operation | isolated thread |
| retry after runtime crash | resume same thread where safe |

The public API MUST NOT expose Codex thread IDs.

### 16.3 Turn construction

The adapter constructs a turn containing:

- the operation name and description;
- validated arguments;
- caller identity;
- task and correlation IDs;
- relevant context references;
- required output schema;
- permitted task-scoped MCP tools;
- explicit completion requirements.

Conceptual payload:

```json
{
  "taskId": "task-01JZ8M0",
  "operation": "review_branch",
  "instruction": "Perform the registered operation exactly as described.",
  "arguments": {
    "repository": "payments-api",
    "branch": "feature/passkeys",
    "scope": "authentication"
  },
  "requiredOutputSchema": {
    "type": "object",
    "properties": {
      "summary": {"type": "string"},
      "findings": {"type": "array"}
    },
    "required": ["summary", "findings"]
  }
}
```

### 16.4 Structured completion tool

The recommended completion mechanism is a task-scoped MCP tool presented to the target runtime:

```text
task.complete
task.fail
task.report_progress
task.request_input
```

`task.complete` is dynamically generated from the pinned output schema.

Example:

```json
{
  "name": "task.complete",
  "description": "Complete the current review_branch task with a valid structured result.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "result": {
        "type": "object",
        "properties": {
          "summary": {"type": "string"},
          "findings": {"type": "array"}
        },
        "required": ["summary", "findings"]
      },
      "summary": {
        "type": "string",
        "description": "Optional short human-readable completion summary."
      }
    },
    "required": ["result"],
    "additionalProperties": false
  }
}
```

This tool call, rather than an unconstrained final prose response, is the authoritative result.

### 16.5 Target agent outbound MCP access

The running target agent connects to the gateway MCP server with a short-lived execution-scoped credential.

It can receive tools such as:

```text
task.complete
task.fail
task.report_progress
task.request_input
xmpp.send_message
xmpp.reply
xmpp.join_room
xmpp.search_archive
agents.discover_endpoints
agents.call_tool
artifacts.upload
```

This allows recursive agent-to-agent calls while preserving identity and policy.

### 16.6 Avoiding recursion hazards

The gateway MUST enforce:

- maximum delegation depth;
- maximum child tasks per task;
- cycle detection where possible;
- tenant and operation budgets;
- deadline inheritance;
- cancellation propagation;
- explicit caller lineage.

Example lineage:

```json
{
  "rootTaskId": "task-root",
  "parentTaskId": "task-parent",
  "depth": 3,
  "callPath": [
    "planner@agents.acme.example",
    "researcher@agents.acme.example",
    "security-reviewer@agents.acme.example"
  ]
}
```

---

## 17. Calling another agent

### 17.1 Discovery-first flow

```text
Agent A
  │
  │ MCP agents.discover_endpoints
  ▼
Gateway
  │
  │ registry + XEP-0030 cache + authorization
  ▼
complete MCP endpoint descriptors
  │
  ▼
Agent A chooses endpoint and tool
  │
  │ MCP tools/call
  ▼
Gateway validates and creates task
  │
  │ XMPP invoke message
  ▼
Agent B logical JID
  │
  │ runtime manager ensures runtime
  ▼
Agent B executes and calls task.complete
  │
  │ XMPP result
  ▼
Gateway completes Agent A's MCP call
```

### 17.2 Direct projected-tool flow

Agent A may skip explicit discovery when the target operation appears in `tools/list`.

```json
{
  "name": "security_reviewer__review_branch",
  "arguments": {
    "repository": "payments-api",
    "branch": "feature/passkeys",
    "scope": "authentication"
  }
}
```

The gateway resolves the projected tool to the canonical endpoint and operation.

### 17.3 Generic invocation flow

```json
{
  "endpointId": "xmpp+mcp://security-reviewer@agents.acme.example",
  "tool": "review_branch",
  "arguments": {
    "repository": "payments-api",
    "branch": "feature/passkeys",
    "scope": "authentication"
  },
  "apiVersion": "1.4.0"
}
```

### 17.4 Nested delegation

While processing the review, Agent B might call a repository-specialist agent:

```text
Security Reviewer
  MCP agents.call_tool(...)
        ↓
same gateway
        ↓
new child task
        ↓
Repository Specialist
```

The child task MUST reference its parent and root task. The parent does not have to remain in a blocking model call if the harness supports asynchronous workflows; otherwise the child call behaves as a nested MCP tool call.

### 17.5 Result provenance

The result metadata SHOULD identify:

- target agent JID;
- operation and API version;
- task ID;
- parent and root task IDs;
- timestamps;
- schema digest;
- runtime/provider identity where policy permits;
- artifact hashes;
- optional signature or audit-event ID.

Provider/model details SHOULD NOT be exposed by default if doing so leaks internal implementation or enables undesirable provider coupling.

---

## 18. Human-agent communication

### 18.1 Ordinary messages

Human text sent to an agent JID is not automatically a structured operation call. It is a conversational event.

The gateway MAY map it to a default operation such as:

```text
conversation.respond
```

only when the agent manifest declares such behavior.

### 18.2 Structured actions in chat

An agent can send:

- readable body text;
- a XEP-0004 form;
- agent-task input metadata;
- reply metadata such as XEP-0461 where supported.

A capable client renders native controls; a basic client still shows fallback instructions.

### 18.3 Multiple-choice questions

For human multiple-choice input:

- use XEP-0004 `list-single` for one choice;
- use XEP-0004 `list-multi` for multiple choices;
- use XEP-0122 for validation where useful.

The gateway maps the submitted form to the JSON input expected by the waiting task.

### 18.4 Rooms

Agents MAY participate in MUC rooms. Room messages are conversational unless they contain a recognized structured invocation payload.

A mention can route attention to an agent, but a mention alone SHOULD NOT authorize a destructive operation.

The gateway SHOULD preserve:

- room JID;
- sender occupant identity;
- stable stanza ID;
- reply relation;
- tenant/workspace scope.

---

## 19. Reliability and persistence

### 19.1 Durable task store

The gateway MUST maintain a durable task store independent of XMPP offline-message behavior.

Minimum task record:

```typescript
interface TaskRecord {
  taskId: string;
  rootTaskId: string;
  parentTaskId?: string;

  callerJid: string;
  targetJid: string;
  tenantId: string;
  workspaceId?: string;

  endpointId: string;
  operation: string;
  apiVersion: string;

  inputSchemaDigest: string;
  outputSchemaDigest?: string;
  arguments: unknown;

  state: TaskState;
  attempt: number;
  idempotencyKey?: string;

  xmppOriginId: string;
  mcpRequestId?: string;
  runtimeId?: string;

  createdAt: string;
  acceptedAt?: string;
  startedAt?: string;
  completedAt?: string;
  deadline?: string;

  result?: unknown;
  error?: TaskError;
}
```

### 19.2 XEP-0198

The gateway SHOULD use XEP-0198 Stream Management where available for connection-level acknowledgement and resumption. XEP-0198 does not replace durable application-level task acknowledgement.

### 19.3 XEP-0184

Delivery receipts MAY confirm message delivery to an entity, but they do not mean a task was authorized or accepted. The `<accepted>` task event is the application-level acknowledgement.

### 19.4 XEP-0359

The gateway SHOULD attach `origin-id` values to task messages and preserve server-assigned stable stanza IDs. These support deduplication, archive correlation, and replies.

### 19.5 MAM

Task stanzas MAY be archived through XEP-0313 where appropriate. The durable task database remains authoritative for task state.

Sensitive arguments and results MAY use message-processing hints or policy controls to prevent ordinary conversational archiving. Archival policy MUST match the data-policy classification.

### 19.6 Duplicate delivery

Every inbound task event MUST be processed idempotently by event ID and task ID.

Duplicate XMPP delivery MUST NOT create a duplicate task execution.

### 19.7 Ordering

Progress events carry monotonically increasing sequence numbers. The gateway SHOULD tolerate out-of-order or duplicate progress messages.

Terminal task state is committed transactionally. A late non-terminal event after a terminal state is ignored and audited.

---

## 20. Authorization and security

### 20.1 Authorization stages

Authorization MUST occur at:

1. endpoint discovery;
2. tool listing;
3. invocation;
4. runtime credential issuance;
5. target-side outward tool calls;
6. result and artifact access.

### 20.2 Discovery filtering

The gateway SHOULD hide unauthorized endpoints and operations completely. It MAY expose visible-but-not-invocable capabilities for marketplace or approval workflows, but the descriptor MUST state that clearly.

### 20.3 Invocation context

The target runtime receives a signed or otherwise integrity-protected context:

```json
{
  "issuer": "agents.acme.example",
  "tenantId": "acme",
  "callerJid": "developer-agent@agents.acme.example",
  "targetJid": "security-reviewer@agents.acme.example",
  "taskId": "task-01JZ8M0",
  "operation": "review_branch",
  "apiVersion": "1.4.0",
  "permissions": [
    "task.complete:task-01JZ8M0",
    "task.progress:task-01JZ8M0",
    "repository.read:payments-api",
    "agents.call:approved"
  ],
  "expiresAt": "2026-07-12T15:50:00Z"
}
```

### 20.4 Runtime credentials

Runtime credentials MUST be:

- short-lived;
- tenant-scoped;
- agent-scoped;
- execution-scoped;
- least privilege;
- revocable or expiration-bounded.

The runtime MUST NOT receive the gateway component secret or broad XMPP credentials.

### 20.5 Schema validation

The gateway validates:

- caller arguments before task acceptance;
- clarification answers;
- target result before completion.

Validation failures from the target produce an internal contract error and SHOULD allow a bounded correction attempt before failing the task.

### 20.6 Prompt injection and untrusted metadata

Operation descriptions and schemas are untrusted content from the standpoint of a calling model. The gateway SHOULD:

- register manifests only from trusted publishers;
- mark publisher and trust level;
- prevent descriptions from overriding system policy;
- limit `_meta` fields exposed to models;
- separate model-facing descriptions from operator-only metadata.

### 20.7 SSRF and external schema references

External `$ref`, icon URLs, homepage URLs, and artifact URLs can cause SSRF. The gateway MUST not fetch arbitrary URLs from manifests at runtime.

### 20.8 Destructive operations

Operations with `destructiveHint: true` SHOULD require explicit policy and MAY require human approval. MCP annotations are hints and MUST NOT be the sole authorization mechanism.

### 20.9 Raw XMPP access

Agent runtimes SHOULD receive high-level MCP tools rather than unrestricted raw stanza-send capability.

If a raw stanza tool exists for trusted agents, it MUST:

- constrain destination domains;
- constrain `from`;
- validate stanza size;
- filter forbidden namespaces;
- record complete audit data.

---

## 21. Versioning and compatibility

### 21.1 API versions

Each agent manifest has a semantic version. Every accepted task pins one exact API version and schema digest.

### 21.2 Change rules

Recommended policy:

| Change | Version impact |
|---|---|
| documentation correction | patch |
| add optional input property | minor |
| add optional output property | minor |
| add operation | minor |
| add required input property | major |
| remove or rename property | major |
| narrow accepted enum incompatibly | major |
| change result structure incompatibly | major |

### 21.3 Tool projection updates

When an agent updates:

- new MCP calls use the latest authorized compatible version unless caller pins another;
- active tasks remain on their pinned version;
- cached discovery is invalidated by manifest digest;
- old schema versions remain available for audit and task completion.

### 21.4 Operation removal

Removing an operation from the latest manifest prevents new discovery and calls. Existing accepted tasks remain executable unless explicitly cancelled by administrative policy.

---

## 22. Errors

### 22.1 Error taxonomy

```text
discovery errors
authorization errors
schema errors
routing errors
runtime startup errors
execution errors
timeout errors
cancellation errors
result-contract errors
gateway internal errors
```

### 22.2 MCP error versus task failure

A request should produce an immediate MCP protocol/tool error when no task was accepted, for example:

- malformed endpoint ID;
- unknown operation;
- unauthorized;
- invalid arguments;
- unsupported API version.

Once a task is accepted, execution failure SHOULD be represented as a task result/failure with task ID and structured metadata.

### 22.3 Structured error example

```json
{
  "taskId": "task-01JZ8M0",
  "status": "failed",
  "error": {
    "code": "runtime-start-failed",
    "message": "The target runtime could not be started.",
    "retryable": true,
    "attempt": 2
  }
}
```

### 22.4 Information leakage

Unauthorized and unknown resources MAY intentionally return the same outward error to avoid revealing agent existence.

---

## 23. Observability

### 23.1 Correlation

The gateway MUST correlate:

```text
MCP request/session ID
task ID
root and parent task IDs
XMPP message and origin IDs
target logical JID
runtime ID
provider thread/turn ID
artifact IDs
```

Provider thread/turn IDs are internal and SHOULD NOT appear in normal client results.

### 23.2 Metrics

Recommended metrics:

- endpoint and tool discovery requests;
- `tools/list` size and generation latency;
- task acceptance rate;
- authorization denials;
- schema validation failures;
- queue time;
- runtime cold-start time;
- execution duration;
- input-required duration;
- cancellation latency;
- completion/failure rate by agent and operation;
- duplicate-message suppression;
- XMPP reconnect/resume counts;
- task delegation depth;
- output-schema correction attempts.

### 23.3 Logs

Logs MUST avoid recording full sensitive arguments/results by default. They SHOULD contain identifiers, state transitions, durations, schema digests, and policy decisions.

### 23.4 Tracing

A trace SHOULD span:

```text
MCP tools/call
→ gateway validation
→ XMPP task creation
→ runtime ensure
→ provider turn
→ target MCP calls
→ structured completion
→ MCP result
```

---

## 24. Recommended TypeScript module structure

```text
src/
├── component/
│   ├── component-connection.ts
│   ├── stanza-router.ts
│   ├── disco-handler.ts
│   ├── schema-iq-handler.ts
│   └── task-stanza-codec.ts
│
├── registry/
│   ├── agent-registry.ts
│   ├── manifest-validator.ts
│   ├── schema-store.ts
│   ├── discovery-index.ts
│   └── version-policy.ts
│
├── mcp/
│   ├── gateway-mcp-server.ts
│   ├── tool-projector.ts
│   ├── directory-tools.ts
│   ├── endpoint-descriptor.ts
│   └── mcp-session-auth.ts
│
├── tasks/
│   ├── task-service.ts
│   ├── task-state-machine.ts
│   ├── task-store.ts
│   ├── idempotency.ts
│   ├── correlation.ts
│   └── task-policy.ts
│
├── runtime/
│   ├── runtime-manager-client.ts
│   ├── runtime-adapter.ts
│   ├── codex-app-server-adapter.ts
│   ├── openai-agent-adapter.ts
│   └── task-scoped-mcp.ts
│
├── auth/
│   ├── policy-engine.ts
│   ├── credential-issuer.ts
│   └── tenant-context.ts
│
├── protocol/
│   ├── namespaces.ts
│   ├── agent-api-types.ts
│   ├── task-types.ts
│   └── errors.ts
│
└── observability/
    ├── metrics.ts
    ├── tracing.ts
    └── audit.ts
```

### 24.1 Core service interfaces

```typescript
interface AgentRegistry {
  register(manifest: AgentApiManifest, principal: Principal): Promise<RegisteredAgent>;
  getAgent(jid: string, version?: string): Promise<RegisteredAgent | null>;
  getOperation(
    jid: string,
    operation: string,
    version?: string
  ): Promise<RegisteredOperation | null>;
  listVisibleAgents(principal: Principal, scope: DiscoveryScope): Promise<RegisteredAgent[]>;
  searchVisibleOperations(
    principal: Principal,
    query: ServiceQuery
  ): Promise<ServiceSearchResult[]>;
}
```

```typescript
interface ToolProjector {
  listTools(principal: Principal, scope: ToolProjectionScope): Promise<McpTool[]>;
  resolveProjectedTool(principal: Principal, toolName: string): Promise<ResolvedOperation>;
}
```

```typescript
interface TaskService {
  create(request: CreateTaskRequest): Promise<TaskRecord>;
  waitForTerminal(taskId: string, options: WaitOptions): Promise<TaskRecord>;
  provideInput(taskId: string, requestId: string, input: unknown): Promise<TaskRecord>;
  cancel(taskId: string, principal: Principal, reason?: string): Promise<TaskRecord>;
}
```

---

## 25. End-to-end example

### 25.1 Agent A discovers a service

MCP call:

```json
{
  "name": "agents.discover_endpoints",
  "arguments": {
    "query": "Review a Git branch for authentication vulnerabilities",
    "includeTools": true,
    "includeSchemas": true,
    "limit": 5
  }
}
```

Gateway behavior:

1. authenticate Agent A;
2. query authorization-filtered registry/search index;
3. map canonical XEP-0030 entities and nodes;
4. return complete endpoint descriptors.

Result excerpt:

```json
{
  "endpoints": [
    {
      "endpointId": "xmpp+mcp://security-reviewer@agents.acme.example",
      "server": {
        "name": "security-reviewer",
        "title": "Security Reviewer",
        "version": "1.4.0"
      },
      "authorization": {
        "visible": true,
        "invocable": true,
        "approvalRequired": false
      },
      "availability": {
        "state": "dormant",
        "coldStartSupported": true
      },
      "tools": [
        {
          "name": "review_branch",
          "description": "Review a Git branch for security vulnerabilities.",
          "inputSchema": {
            "type": "object",
            "properties": {
              "repository": {"type": "string"},
              "branch": {"type": "string"},
              "scope": {
                "type": "string",
                "enum": ["changed_files", "authentication", "complete"]
              }
            },
            "required": ["repository", "branch"]
          },
          "outputSchema": {
            "type": "object",
            "properties": {
              "summary": {"type": "string"},
              "findings": {"type": "array"}
            },
            "required": ["summary", "findings"]
          }
        }
      ]
    }
  ]
}
```

### 25.2 Agent A calls the service

```json
{
  "name": "agents.call_tool",
  "arguments": {
    "endpointId": "xmpp+mcp://security-reviewer@agents.acme.example",
    "tool": "review_branch",
    "arguments": {
      "repository": "payments-api",
      "branch": "feature/passkeys",
      "scope": "authentication"
    }
  }
}
```

### 25.3 Gateway creates the task

The gateway:

- resolves endpoint and operation;
- authorizes the call;
- validates arguments;
- pins API version and schema digests;
- creates `task-01JZ8M0`;
- sends the XMPP invocation;
- returns/streams acceptance depending on mode.

### 25.4 Target is dormant

The task dispatcher invokes:

```typescript
runtimeManager.ensureRuntime({
  tenantId: "acme",
  agentJid: "security-reviewer@agents.acme.example",
  taskId: "task-01JZ8M0",
  apiVersion: "1.4.0",
  operation: "review_branch",
  credentialGrant: {
    permissions: [
      "task.complete:task-01JZ8M0",
      "task.progress:task-01JZ8M0",
      "task.input:task-01JZ8M0"
    ]
  }
});
```

### 25.5 Runtime adapter starts a turn

The Codex adapter creates or resumes the appropriate thread and starts a turn with the operation contract and arguments.

### 25.6 Target reports progress

Agent B calls:

```json
{
  "name": "task.report_progress",
  "arguments": {
    "percent": 45,
    "stage": "analysis",
    "message": "Reviewing authentication challenge lifecycle."
  }
}
```

The gateway records the state and emits the XMPP progress event. It also reports MCP progress where supported.

### 25.7 Target needs clarification

Agent B calls:

```json
{
  "name": "task.request_input",
  "arguments": {
    "question": "Should generated files be included?",
    "inputSchema": {
      "type": "object",
      "properties": {
        "includeGenerated": {"type": "boolean"}
      },
      "required": ["includeGenerated"]
    }
  }
}
```

Agent A answers through `agents.answer_input`, or the gateway renders a human XEP-0004 form.

### 25.8 Target completes

Agent B calls the dynamically typed `task.complete` tool:

```json
{
  "name": "task.complete",
  "arguments": {
    "result": {
      "summary": "Two authentication issues were identified.",
      "findings": [
        {
          "severity": "high",
          "file": "src/auth/passkey.ts",
          "line": 142,
          "description": "The challenge can be reused.",
          "recommendation": "Mark the challenge consumed atomically."
        }
      ]
    },
    "summary": "Review completed with two findings."
  }
}
```

### 25.9 Gateway completes caller MCP call

The gateway validates the result, commits `COMPLETED`, sends the XMPP result, and returns MCP structured content to Agent A.

---

## 26. Interoperability profile

### 26.1 Required XMPP capabilities

The core gateway profile requires:

- RFC 6120 XMPP Core;
- RFC 6121 XMPP IM as applicable;
- XEP-0030 Service Discovery;
- XEP-0114 Jabber Component Protocol;
- XEP-0004 Data Forms for extended metadata and human forms;
- XEP-0128 Service Discovery Extensions pattern.

### 26.2 Strongly recommended XEPs

- XEP-0198 Stream Management;
- XEP-0359 Unique and Stable Stanza IDs;
- XEP-0184 Message Delivery Receipts;
- XEP-0313 Message Archive Management where policy permits;
- XEP-0334 Message Processing Hints;
- XEP-0461 Message Replies for conversational correlation;
- XEP-0122 Data Forms Validation for richer human forms.

### 26.3 Optional XEPs

- XEP-0432 Simple JSON Messaging as a standard JSON container;
- XEP-0363 HTTP File Upload;
- XEP-0446 File Metadata Element;
- XEP-0447 Stateless File Sharing;
- XEP-0060 Publish-Subscribe for manifest-change and directory events;
- XEP-0503 Server-side Spaces for workspace organization;
- XEP-0050 Ad-Hoc Commands for administrative control-plane operations.

### 26.4 Openfire behavior

For client-semantic payloads such as embedded JSON or custom task elements, Openfire generally only needs to route unknown XML payloads transparently.

Openfire or a plugin needs explicit implementation only where the server itself owns semantics, such as:

- component routing;
- archive behavior;
- PubSub behavior;
- server-side spaces;
- privileged/delegated operations;
- custom server-side indexing or policy enforcement.

The custom Agent API and task namespaces can primarily be implemented in the gateway component.

---

## 27. Conformance

### 27.1 Gateway conformance

A conforming gateway MUST:

- connect as an authorized XMPP component;
- maintain stable logical agent identities;
- validate and register Agent API Manifests;
- expose agent and operation discovery through XEP-0030;
- expose complete MCP endpoint descriptors;
- project authorized operations into MCP or provide equivalent generic invocation;
- validate operation arguments;
- create durable tasks;
- route task lifecycle messages over XMPP;
- integrate with a runtime manager through a provider-neutral interface;
- validate structured results;
- enforce tenant and operation authorization;
- implement idempotency and terminal-state safety;
- retain pinned schema versions for active tasks.

### 27.2 Agent package conformance

A conforming gateway-managed agent package MUST provide:

- a valid Agent API Manifest;
- unique operation names;
- valid JSON Schemas;
- runtime configuration understood by the external runtime manager;
- instructions or implementation capable of completing registered operations;
- use of the task-scoped completion contract.

### 27.3 Calling-agent conformance

A calling agent MAY:

- use projected MCP tools;
- use explicit endpoint discovery and generic invocation;
- call synchronously or asynchronously;
- answer clarification requests;
- cancel accepted tasks.

A caller MUST NOT fabricate XMPP caller identities or assume that discovery implies authorization to invoke.

---

## 28. Future extensions

Potential future work includes:

- standardizing the Agent API and task namespaces as ProtoXEPs;
- federated discovery across XMPP domains;
- signed manifests and results;
- PubSub-backed directory change streams;
- standardized cost and SLA metadata;
- resumable streaming result fragments;
- artifact-first operation results;
- capability negotiation for multimodal input;
- distributed approval workflows;
- formal mapping to A2A task semantics;
- registry replication;
- semantic version negotiation;
- decentralized agent identities;
- tool bundles loaded on demand to reduce MCP context size.

---

## 29. Security checklist

Before production deployment, verify:

- [ ] Component secret stored outside application configuration.
- [ ] Gateway cannot emit arbitrary spoofed JIDs.
- [ ] Every MCP session maps to a verified principal.
- [ ] Discovery is tenant- and permission-filtered.
- [ ] Tool calls are authorized independently of visibility.
- [ ] All arguments and results are schema-validated.
- [ ] External schema references are disabled or allowlisted.
- [ ] Runtime credentials are short-lived and task-scoped.
- [ ] Delegation depth and task fan-out are bounded.
- [ ] Cancellation propagates to child tasks according to policy.
- [ ] Sensitive payloads are excluded from logs.
- [ ] MAM/archive policy matches data classification.
- [ ] Destructive operations have explicit approval policy.
- [ ] Duplicate XMPP messages cannot duplicate execution.
- [ ] Historical schema versions remain immutable.
- [ ] Runtime/provider identifiers are not leaked unnecessarily.
- [ ] Endpoint descriptions are treated as untrusted model-facing content.
- [ ] Artifact URLs and icons cannot cause SSRF.
- [ ] Task deadlines and resource budgets are enforced.

---

## 30. References

### XMPP

- XEP-0004: Data Forms — https://xmpp.org/extensions/xep-0004.html
- XEP-0030: Service Discovery — https://xmpp.org/extensions/xep-0030.html
- XEP-0050: Ad-Hoc Commands — https://xmpp.org/extensions/xep-0050.html
- XEP-0060: Publish-Subscribe — https://xmpp.org/extensions/xep-0060.html
- XEP-0114: Jabber Component Protocol — https://xmpp.org/extensions/xep-0114.html
- XEP-0122: Data Forms Validation — https://xmpp.org/extensions/xep-0122.html
- XEP-0128: Service Discovery Extensions — https://xmpp.org/extensions/xep-0128.html
- XEP-0184: Message Delivery Receipts — https://xmpp.org/extensions/xep-0184.html
- XEP-0198: Stream Management — https://xmpp.org/extensions/xep-0198.html
- XEP-0313: Message Archive Management — https://xmpp.org/extensions/xep-0313.html
- XEP-0334: Message Processing Hints — https://xmpp.org/extensions/xep-0334.html
- XEP-0359: Unique and Stable Stanza IDs — https://xmpp.org/extensions/xep-0359.html
- XEP-0363: HTTP File Upload — https://xmpp.org/extensions/xep-0363.html
- XEP-0432: Simple JSON Messaging — https://xmpp.org/extensions/xep-0432.html
- XEP-0446: File Metadata Element — https://xmpp.org/extensions/xep-0446.html
- XEP-0447: Stateless File Sharing — https://xmpp.org/extensions/xep-0447.html
- XEP-0461: Message Replies — https://xmpp.org/extensions/xep-0461.html
- XEP-0503: Server-side Spaces — https://xmpp.org/extensions/xep-0503.html

### MCP

- MCP Tools specification — https://modelcontextprotocol.io/specification/2025-11-25/server/tools
- MCP Schema reference — https://modelcontextprotocol.io/specification/2025-11-25/schema

### Codex

- Codex app-server — https://developers.openai.com/codex/app-server
- Codex MCP integration — https://developers.openai.com/codex/mcp
- Codex SDK — https://developers.openai.com/codex/sdk

---

## Appendix A. Suggested JSON types

```typescript
export interface AgentApiManifest {
  specVersion: "urn:businessos:agent-api:1";
  agent: AgentIdentity;
  capabilities: AgentCapabilities;
  operations: AgentOperation[];
}

export interface AgentIdentity {
  jid: string;
  name: string;
  title?: string;
  description?: string;
  version: string;
  vendor?: string;
  homepage?: string;
  icons?: AgentIcon[];
}

export interface AgentOperation {
  name: string;
  title?: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  execution?: AgentExecutionMetadata;
  authorization?: AgentAuthorizationMetadata;
  tags?: string[];
}

export interface VirtualMcpEndpoint {
  endpointId: string;
  transport: {
    kind: "xmpp-gateway";
    gateway: string;
  };
  server: {
    name: string;
    title?: string;
    description?: string;
    version: string;
    icons?: AgentIcon[];
  };
  capabilities: Record<string, unknown>;
  xmpp: {
    jid: string;
    endpointNode: string;
    toolsNode: string;
    features: string[];
  };
  authorization: {
    visible: boolean;
    invocable: boolean;
    approvalRequired: boolean;
  };
  availability: {
    state: "available" | "busy" | "dormant" | "unavailable";
    coldStartSupported: boolean;
    estimatedColdStartSeconds?: number;
  };
  tools: McpToolDescriptor[];
}
```

---

## Appendix B. Recommended database tables

```text
agents
agent_api_versions
agent_operations
agent_schema_blobs
agent_visibility_rules
agent_operation_permissions
tasks
task_attempts
task_events
task_inputs
task_results
task_idempotency
runtime_bindings
mcp_sessions
discovery_cache
audit_events
```

Important uniqueness constraints:

```text
agents(jid)
agent_api_versions(agent_id, version)
agent_operations(api_version_id, operation_name)
agent_schema_blobs(digest)
tasks(task_id)
task_idempotency(caller_id, endpoint_id, operation, idempotency_key)
task_events(task_id, event_id)
```

---

## Appendix C. Design decisions summary

| Decision | Choice | Rationale |
|---|---|---|
| Public agent API schema | MCP-compatible manifest | Natural for calling LLM agents |
| Distributed discovery | XEP-0030 + XEP-0128 | Native XMPP identities, features, and nodes |
| Full schema transport | Custom IQ or immutable reference | Avoid overloading disco forms |
| Invocation transport | XMPP message task | Supports long-running durable work |
| Short metadata queries | IQ | Natural request/response semantics |
| Caller-facing transport | MCP | Native model tool interface |
| Last mile | Runtime adapter | Provider-independent gateway |
| Codex integration | app-server internally | Correct thread/turn control boundary |
| Structured completion | task-scoped MCP completion tool | Enforced output contract |
| Dormant agent API | registry-backed virtual endpoint | Discovery without running container |
| Synchronous calls | wrapper over durable task | Reliability and recoverability |
| Human choices | JSON Schema canonical, XEP-0004 rendering | Machine richness plus XMPP UI |
| Openfire customization | minimal | Most custom payloads are gateway semantics |
