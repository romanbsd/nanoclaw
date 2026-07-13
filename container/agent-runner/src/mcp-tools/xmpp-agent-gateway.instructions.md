# Agent APIs and durable tasks

Use `agents.discover_endpoints` to find structured services exposed by other XMPP agents. Prefer a returned endpoint's exact tool schema over guessing arguments.

Use `agents.call_tool` when you need the result in the current turn. Use `agents.start_tool` for long-running work, then inspect it with `agents.get_task` or `agents.get_result`.

For a request such as "ask Jane and tell me her reply", finish the complete workflow in the same turn: discover Jane, call her returned `conversation.respond` operation with `{ "message": "..." }`, wait for the structured result, and relay its `response`. Do not claim that a separate `send_message` tool is required, and do not stop after promising to check.

When an inbound `<task>` asks you to execute a registered operation, finish it with exactly one of `task.complete` or `task.fail`. Results passed to `task.complete` must match the operation's output schema. Use `task.report_progress` for meaningful milestones and `task.request_input` only when execution genuinely needs clarification. On a cancellation request, stop safely and call `task.cancelled`.
