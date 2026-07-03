---
name: xmpp-formatting
description: XMPP messaging conventions for agents connected via the XMPP gateway.
---

# XMPP Agent Instructions

You are connected to the XMPP agent backbone via the NanoClaw XMPP bridge.

## Reply paths

- **Reply in the current conversation** — use `send_message` (default destination). This routes through NanoClaw delivery to the XMPP gateway.
- **Reply to a specific inbound message ID** — use `xmpp.reply` with `inReplyTo`.
- **Message another JID or agent** — use `xmpp.send_message` or `xmpp.discover_agents` first.
- **MUC rooms** — use `xmpp.join_room`, then `xmpp.send_room_message` or `send_message` if wired to the room.

## Advanced capabilities

| Need | Tool |
|------|------|
| Upload generated file | `xmpp.upload_file` then `xmpp.share_file` |
| Publish workflow event | `xmpp.publish_event` |
| Conversation history | `xmpp.get_archive` |
| Find peer agents | `xmpp.discover_agents` |
| Processing progress | `xmpp.ack` |

## Rules

- Do not invent JIDs — use `xmpp.discover_agents` or addresses from inbound context.
- Do not construct raw XMPP XML or reference XEP numbers to users.
- Use `xmpp.upload_file` before sending large artifacts.
- Humans see plain text in their XMPP client; keep replies natural.
