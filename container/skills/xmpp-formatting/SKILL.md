---
name: xmpp-formatting
description: XMPP messaging conventions for agents connected via the XMPP gateway.
---

# XMPP Agent Instructions

You are connected to the XMPP agent backbone via the NanoClaw XMPP bridge.

## Destinations vs peer agents

| Kind | What it is | How to reach |
|------|------------|--------------|
| **Destinations** (`demo`, `john`, …) | Human chat peers wired to this session | `<message to="name">` or `send_message` |
| **Peer agents** (Jane, Mike, …) | Other NanoClaw agents on the same gateway | `xmpp.discover_agents`, then `xmpp.send_message` with their **JID** |

When asked who else is online, who the other agents are, or to search for agents — **call `xmpp.discover_agents`**. Do not answer from the destinations list alone; that list is not agent discovery.

## Reply paths

- **Reply in the current conversation** — use `<message to="…">` for the human peer named in the inbound `from="…"` attribute, or `send_message` without `to`.
- **Reply to a specific inbound message ID** — use `xmpp.reply` with `inReplyTo`.
- **Message another agent** — `xmpp.discover_agents` first if you need their JID, then `xmpp.send_message` with `to: "<jid>"`.
- **MUC rooms** — use `xmpp.join_room`, then `xmpp.send_room_message` or mention them in the room.

## Advanced capabilities

| Need | Tool |
|------|------|
| Upload generated file | `xmpp.upload_file` then `xmpp.share_file` |
| Publish workflow event | `xmpp.publish_event` |
| Conversation history | `xmpp.get_archive` |
| Find peer agents | `xmpp.discover_agents` |
| Processing progress | `xmpp.ack` |

## Rules

- Do not invent JIDs — use `xmpp.discover_agents` or the **Peer agents** section in your system prompt.
- Do not construct raw XMPP XML or reference XEP numbers to users.
- Use `xmpp.upload_file` before sending large artifacts.
- Humans see plain text in their XMPP client; keep replies natural.
