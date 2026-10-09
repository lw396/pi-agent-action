# pi-agent-action

A GitHub Action that runs the [pi coding agent](https://github.com/earendil-works/pi) on your issues and pull requests. Mention `@pi` in a comment to have it answer a question, review a change or implement a fix (tag mode), or give it a `prompt` to run an automation (agent mode). It works with any model pi supports.

> [!NOTE]
> This project is based on [anthropics/claude-code-action](https://github.com/anthropics/claude-code-action) (MIT) and is meant as a drop-in replacement for it. It is not an official product of Anthropic or of the pi project.
>
> It is a work in progress. This README, [docs/security.md](./docs/security.md) and [docs/upstream-divergence.md](./docs/upstream-divergence.md) describe pi-agent-action; the other pages under `docs/` still describe claude-code-action and will be rewritten.

## Quickstart

```yaml
name: pi

on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]
  issues:
    types: [opened, assigned]

permissions:
  contents: write
  pull-requests: write
  issues: write

jobs:
  pi:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: lw396/pi-agent-action@main
        with:
          # Required: a pi model as provider/id
          model: openai/<model-id>
          github_token: ${{ secrets.GITHUB_TOKEN }}
          # Optional: commands the agent may run besides git add/commit/push
          allowed_tools: "Bash(npm test:*)"
        env:
          # The provider's key, under the variable name pi reads
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

Only users with write access to the repository can trigger the action. Pass the provider key in the workflow `env:` under the name pi reads for that provider (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `OPENCODE_API_KEY`, ...), or in the `api_key` input.

The Quickstart passes the workflow's `GITHUB_TOKEN`, so comments come from `github-actions[bot]`, and pushes and pull requests made with it do not start other workflows. To act as `pi-agent-action[bot]` instead, install the [pi-agent-action app](https://github.com/apps/pi-agent-action) on the repository, grant the job `id-token: write` and remove `github_token`: the action then exchanges the workflow's OIDC token for a token of the app. Repositories without the app keep `github_token`, or pass a token of their own app ([docs/setup.md](./docs/setup.md#using-a-custom-github-app)).

The agent can always read files. Any other tool call (bash, file edits outside tag mode, MCP tools) runs only if `allowed_tools` permits it, and there is no safety review of the calls it permits. Read [docs/security.md](./docs/security.md) before you allow broad tools such as `Bash`.

## Migrating from claude-code-action

Most workflows need four changes:

1. Point `uses:` at `lw396/pi-agent-action`.
2. Set `model` and pass the provider's key.
3. Replace `claude_args` with the inputs listed under [Removed inputs](#removed-inputs).
4. List in `allowed_tools` the tools the job needs. Without a rule the agent cannot run bash or change files in agent mode.

```yaml
# Before
- uses: anthropics/claude-code-action@v1
  with:
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    claude_args: |
      --model <model-id>
      --allowedTools "Bash(npm test:*),Edit,Write"

# After
- uses: lw396/pi-agent-action@main
  with:
    model: anthropic/<model-id>
    allowed_tools: "Bash(npm test:*),Edit,Write"
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

### Removed inputs

A workflow that still sets one of these inputs fails, naming the input and what to use instead.

| Removed input                                                                                                                                    | YAML change                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `anthropic_api_key`                                                                                                                              | `model: anthropic/<id>`, and `ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}` in `env:` (or `api_key: ${{ secrets.ANTHROPIC_API_KEY }}`)                     |
| `claude_code_oauth_token`                                                                                                                        | An API key for the model's provider, in `env:` under pi's variable name or in `api_key`                                                                           |
| `anthropic_federation_rule_id`, `anthropic_organization_id`, `anthropic_service_account_id`, `anthropic_workspace_id`, `anthropic_oidc_audience` | Not supported: remove them and use an API key for the model's provider                                                                                            |
| `use_bedrock`                                                                                                                                    | `model: amazon-bedrock/<id>`, and AWS credentials (`AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`, or `AWS_PROFILE`) and `AWS_REGION` in `env:`                  |
| `use_vertex`                                                                                                                                     | `model: google-vertex/<id>`, and `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION` and Application Default Credentials (`GOOGLE_APPLICATION_CREDENTIALS`) in `env:` |
| `use_foundry`                                                                                                                                    | Not supported: pi has no Microsoft Foundry provider; choose another provider in `model`                                                                           |
| `claude_args`                                                                                                                                    | See the flag table below                                                                                                                                          |
| `settings`                                                                                                                                       | Not supported: remove it; move permission rules to `allowed_tools` / `disallowed_tools`                                                                           |
| `plugins`, `plugin_marketplaces`                                                                                                                 | Not supported: remove them                                                                                                                                        |
| `path_to_claude_code_executable`                                                                                                                 | Remove it: pi runs inside the action's own process, at the version the action pins                                                                                |

Flags from `claude_args`:

| `claude_args` flag                                 | YAML change                                                                                      |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `--model <id>`                                     | `model: <provider>/<id>`; append `:<level>` for a thinking level, e.g. `model: openai/<id>:high` |
| `--allowedTools "..."`                             | `allowed_tools: "..."`, same rule syntax                                                         |
| `--disallowedTools "..."`                          | `disallowed_tools: "..."`                                                                        |
| `--json-schema '...'`                              | `json_schema: '...'`; the schema's root must be `"type": "object"`                               |
| `--system-prompt "..."`                            | `pi_args: --system-prompt "..."` (`pi_args` takes pi's own flags only; see the `pi_args` input)  |
| `--append-system-prompt "..."`                     | `pi_args: --append-system-prompt "..."`                                                          |
| `--add-dir <dir>`                                  | Remove it: the read tools can read any path                                                      |
| `--max-turns`, `--permission-mode`, `--mcp-config` | Remove them: there is no equivalent, and `pi_args` fails on them                                 |

### Changed behaviour

Every row below changes something a workflow can observe. [docs/upstream-divergence.md](./docs/upstream-divergence.md) gives the reason for each, and lists the differences that need no change.

| Area                                        | claude-code-action                                                                                   | pi-agent-action                                                                                                                                                                           | YAML change                                                                                                                                                                  |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model                                       | Default model, or `--model` in `claude_args`                                                         | No default: `model` is required                                                                                                                                                           | `model: <provider>/<id>`                                                                                                                                                     |
| GitHub App                                  | Without `github_token`, a token for the Claude app (`claude[bot]`) from Anthropic's exchange service | Without `github_token`, a token for the pi-agent-action app (`pi-agent-action[bot]`) from this project's exchange service; `bot_id` / `bot_name` default to that bot                      | Install https://github.com/apps/pi-agent-action, or set `github_token`                                                                                                       |
| Trigger defaults                            | `@claude`, label `claude`, branch prefix `claude/`                                                   | `@pi`, `pi`, `pi/`                                                                                                                                                                        | To keep the old ones: `trigger_phrase: "@claude"`, `label_trigger: claude`, `branch_prefix: claude/`                                                                         |
| Tool permissions                            | Rules plus `--permission-mode auto`, which reviews calls no rule covers                              | A call that no `allowed_tools` rule covers is refused; the read tools (Read, Grep, Glob, LS) always run; no safety review                                                                 | `allowed_tools: "Bash(npm test:*),Edit,Write"`; plain `Bash` allows every command                                                                                            |
| Compound bash commands                      | `&&`, `;`, `\|` are split and each part matched                                                      | With a `Bash(...)` rule in play, `&&`, `;`, `\|`, `$()`, redirections and similar are refused; no built-in read-only commands (tag mode still allows `git status`, `diff`, `log`, `show`) | List every command the job runs: `allowed_tools: "Bash(npm ci:*),Bash(npm test:*),Bash(ls:*)"`                                                                               |
| Rule patterns for other tools               | `Read(src/**)`, `Edit(docs/**)`, `WebFetch(domain:...)`                                              | Only Bash rules take a pattern; any other pattern fails the run. WebFetch and WebSearch rules are ignored with a warning                                                                  | `allowed_tools: "Edit,Write"` instead of `Edit(docs/**)`; remove WebFetch and WebSearch rules                                                                                |
| Repository settings                         | `.claude/settings.json` in the repository is read                                                    | Neither `.claude/settings.json` nor `.pi/settings.json` is read                                                                                                                           | Move its `permissions.allow` / `deny` to `allowed_tools` / `disallowed_tools`                                                                                                |
| MCP servers                                 | Extra servers through `--mcp-config` or the repository's MCP config                                  | Only the action's own GitHub servers                                                                                                                                                      | No replacement yet: remove `--mcp-config`                                                                                                                                    |
| Comment tool name                           | `mcp__github_comment__update_claude_comment`                                                         | `mcp__github_comment__update_comment`                                                                                                                                                     | Rename it in `prompt` and `allowed_tools`                                                                                                                                    |
| Agent env variables                         | `ANTHROPIC_*`, `CLAUDE_CODE_*`, `MCP_TIMEOUT`, `OTEL_*` in `env:` take effect                        | Not read                                                                                                                                                                                  | Remove them; set the provider variables pi reads, e.g. `AWS_REGION`, `GOOGLE_CLOUD_PROJECT`                                                                                  |
| Script call caps                            | `CLAUDE_CODE_SCRIPT_CAPS: '{"script.sh":2}'` in `env:`                                               | Not supported; ignored                                                                                                                                                                    | Remove it; limit which scripts run with `allowed_tools: "Bash(./script.sh:*)"`                                                                                               |
| Inline comment classification               | Claude Haiku, key from `anthropic_api_key`                                                           | Through pi with the `model` input; `classify_model` picks a classifier (e.g. `opencode/jev-1.13`) or another chat model. Every buffered comment is posted when classification fails       | Nothing; set `classify_model` to use another model, with its provider's key in `env:`                                                                                        |
| Bash env with `allowed_non_write_users`     | Built-in blocklist; `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: 0` turns it off                               | Allowlist; `GH_TOKEN` and provider keys are removed                                                                                                                                       | `allowed_bash_env: GH_TOKEN` for `git push` / `gh` in bash (or `use_commit_signing: true`); `subprocess_isolation: false` to turn it off                                     |
| Bash sandbox with `allowed_non_write_users` | Built-in sandbox                                                                                     | bubblewrap where it works: only the working directory and an empty `/tmp` are writable                                                                                                    | Point caches into the workspace, e.g. `npm_config_cache: ${{ github.workspace }}/.npm` in `env:` plus `allowed_bash_env: npm_config_cache`; or `subprocess_isolation: false` |
| Output redaction                            | Known token formats                                                                                  | Also every env value of 16 or more characters that is not on the allowlist, so long non-secret values show as `[REDACTED]` in comments and the step summary                               | To keep a long non-secret value visible, write it into `prompt` instead of `env:`                                                                                            |
| Structured output                           | `--json-schema` in `claude_args`                                                                     | `json_schema` input; same `structured_output` output                                                                                                                                      | `json_schema: '{"type":"object",...}'`                                                                                                                                       |
| Execution file                              | Agent SDK messages; cost in the final `result` message                                               | pi events; totals in the final `session_stats` record                                                                                                                                     | None in YAML; a script that reads `execution_file` must read `session_stats` (`cost`, `durationMs`)                                                                          |
| Step summary                                | `Claude Code Report` from SDK messages                                                               | `pi Agent Report` from pi events, with token and cost totals                                                                                                                              | None                                                                                                                                                                         |
| Full output                                 | `show_full_output`, or `ACTIONS_STEP_DEBUG: true` in `env:`, prints messages unredacted              | `show_full_output`, or a run with debug logging enabled, prints pi events, redacted                                                                                                       | Replace `ACTIONS_STEP_DEBUG: true` in `env:` with `show_full_output: true`, or re-run the job with debug logging                                                             |
| `session_id` output                         | Can be resumed with `--resume`                                                                       | pi's session ID; the session cannot be resumed                                                                                                                                            | Remove later steps that resume the session; read the run from `execution_file`                                                                                               |
| Approval check                              | `anthropics/claude-code-action/agent-approval-check` sub-action                                      | Not included                                                                                                                                                                              | Keep `uses: anthropics/claude-code-action/agent-approval-check@main` (as upstream's example does); add the identity the action commits as to `agent_emails` / `agent_logins` |

## Documentation

- [Security](./docs/security.md): access control, tool permissions, bash isolation, redaction, and what is weaker than in claude-code-action
- [Differences from claude-code-action](./docs/upstream-divergence.md): every divergence and its reason
- [Port proposal](./docs/pi-port-proposal.md): the plan, milestones and open questions
- Not yet rewritten for pi: [Solutions](./docs/solutions.md), [Setup](./docs/setup.md), [Usage](./docs/usage.md), [Custom Automations](./docs/custom-automations.md), [Configuration](./docs/configuration.md), [Capabilities & Limitations](./docs/capabilities-and-limitations.md), [FAQ](./docs/faq.md)

## Contributing

### Setup

Requires the [Bun](https://bun.sh/) runtime.

```bash
git clone https://github.com/lw396/pi-agent-action.git
cd pi-agent-action
bun install
```

### Scripts

- `bun test` - Run all tests
- `bun run typecheck` - Type check the code
- `bun run format` - Format code with Prettier
- `bun run format:check` - Check code formatting

### Pull Request Process

1. Create a new branch from `main`, e.g. `git checkout -b feature/your-feature-name`
2. Make your changes and commit them using [Conventional Commits](https://www.conventionalcommits.org/) (e.g. `feat: add new feature`)
3. Run `bun test`, `bun run typecheck` and `bun run format:check`
4. Push your branch, open a Pull Request, and make sure all CI checks pass

### Testing Changes in a Real Workflow

Unit tests don't exercise the action end to end. To try your changes, create a test repository and point a workflow at your branch:

```yaml
uses: your-username/pi-agent-action@your-branch
```

Then check the GitHub Actions logs for runtime issues.

### Running Workflows Locally with act

[act](https://github.com/nektos/act) runs the workflows in `.github/workflows/` locally in Docker containers.

Prerequisites:

- [Docker](https://www.docker.com/) is running (check with `docker ps`)
- act is installed, e.g. `brew install act`, `gh extension install https://github.com/nektos/gh-act`, or the [install script](https://nektosact.com/installation/index.html)

Run the CI workflow (unit tests, Prettier and typecheck jobs):

```bash
act pull_request -W .github/workflows/ci.yml
```

Run a single job, with verbose output for debugging:

```bash
act pull_request -W .github/workflows/ci.yml -j test -v
```

Limitations of the integration workflows (`test-*.yml`):

- They run on the `ubuntu-24.04-firewall` runner, which act doesn't know. Map it to a regular image with `-P ubuntu-24.04-firewall=catthehacker/ubuntu:act-latest`. The egress firewall is not applied locally.
- They authenticate to the model provider with an API key secret, e.g. `--secret OPENCODE_API_KEY="$OPENCODE_API_KEY"`.

## License

This project is licensed under the MIT License—see the LICENSE file for details.
