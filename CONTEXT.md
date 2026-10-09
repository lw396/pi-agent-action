# pi-agent-action

A GitHub Action that runs the pi coding agent in response to GitHub events, as a drop-in replacement for claude-code-action.

## Language

**Upstream**:
The anthropics/claude-code-action repository that this project is ported from, and whose behaviour towards workflows it stays compatible with. The code is maintained independently of it.
_Avoid_: Original, Claude version

**Divergence**:
A behaviour that differs from Upstream for one of four allowed reasons and is recorded in `docs/development/upstream-divergence.md`.
_Avoid_: Difference, change, deviation

**Runner**:
The component that runs a pi session on a prepared prompt and produces the execution file.
_Avoid_: Executor, base-action

**Execution file**:
The record of one Runner session (turns, tool calls, usage), exposed as an action output.
_Avoid_: Transcript, log

**Token exchange service**:
The service this project runs (`services/token-exchange/`, on Cloudflare Workers) that trades a workflow's GitHub OIDC token for an installation token of the project's GitHub App, used when the `github_token` input is not set. See ADR-0003.
_Avoid_: Token server, OIDC proxy, exchange endpoint

**Tag mode**:
The mode in which the action is triggered by a trigger phrase, label, or assignee on an issue or PR.

**Agent mode**:
The mode in which the action runs the `prompt` input directly, without a trigger.

**Trigger phrase**:
The mention text (default `@pi`) that activates tag mode in a comment or issue body.
_Avoid_: Mention, tag
