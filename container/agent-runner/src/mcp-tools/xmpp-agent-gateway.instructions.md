# Agent APIs and durable tasks

Use `agents.discover_endpoints` to find structured services exposed by other XMPP agents. Prefer a returned endpoint's exact tool schema over guessing arguments.

Use `agents.call_tool` when you need the result in the current turn. Use `agents.start_tool` for long-running work, then inspect it with `agents.get_task` or `agents.get_result`.

When an inbound `<task>` asks you to execute a registered operation, finish it with exactly one of `task.complete` or `task.fail`. Results passed to `task.complete` must match the operation's output schema. Use `task.report_progress` for meaningful milestones and `task.request_input` only when execution genuinely needs clarification. On a cancellation request, stop safely and call `task.cancelled`.
