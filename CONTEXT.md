# pi-agent-action

A GitHub Action that runs the pi coding agent in response to GitHub events, as a drop-in replacement for claude-code-action.

## Language

**Upstream**:
The anthropics/claude-code-action repository that this project is ported from and stays aligned with.
_Avoid_: Original, Claude version

**Divergence**:
A behaviour that differs from Upstream for one of four allowed reasons and is recorded in `docs/upstream-divergence.md`.
_Avoid_: Difference, change, deviation

**Runner**:
The component that runs a pi session on a prepared prompt and produces the execution file.
_Avoid_: Executor, base-action, 执行器

**Execution file**:
The record of one Runner session (turns, tool calls, usage), exposed as an action output.
_Avoid_: Transcript, log

**Tag mode**:
The mode in which the action is triggered by a trigger phrase, label, or assignee on an issue or PR.

**Agent mode**:
The mode in which the action runs the `prompt` input directly, without a trigger.

**Trigger phrase**:
The mention text (default `@pi`) that activates tag mode in a comment or issue body.
_Avoid_: Mention, tag
