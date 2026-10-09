# Security Policy

## Reporting a vulnerability

Please do not report security problems in public issues, discussions or pull requests.

Report them privately through [GitHub's vulnerability reporting](https://github.com/lw396/pi-agent-action/security/advisories/new) (the repository's **Security** tab → **Report a vulnerability**). Include:

- what an attacker can do, and who the attacker has to be (anyone who can comment, a repository collaborator, a pull request author, ...)
- the steps or the workflow to reproduce it
- the version (tag or commit SHA) of the action you tested

You should get a first response within a week. We will keep you updated while we work on a fix, and credit you in the advisory unless you prefer otherwise.

## Scope

In scope:

- the action in this repository (`action.yml`, `src/`): access checks, token handling, tool permissions, bash isolation, output redaction, and prompt construction
- the token exchange service (`services/token-exchange/`) and the pi-agent-action GitHub App it issues tokens for

Out of scope, unless the action makes them worse than documented:

- prompt injection that only does what the workflow's `allowed_tools` permits; [docs/security.md](../docs/security.md) describes these limits and how to configure around them
- vulnerabilities in pi itself, which go to the [pi project](https://github.com/earendil-works/pi), or in claude-code-action, which go to [Anthropic](https://github.com/anthropics/claude-code-action/security)
- the model providers' services

## Supported versions

Fixes go into `main` and the latest release. Pin the action to a release tag or commit SHA, and update when a security release is published.
