# Configuration

Recipes for the settings most workflows change. [Usage](./usage.md#inputs) lists every input.

## Choosing a model

Set `model` to `<provider>/<model-id>` and pass the provider's key in `env:` ([Model providers](./setup.md#model-providers)). Append `:<level>` for a thinking level:

```yaml
- uses: lw396/pi-agent-action@v1
  with:
    model: openai/<model-id>:high
  env:
    OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

Inline review comments are classified by `model` too. To use a cheaper model or a dedicated classifier for that, set `classify_model` and add its provider's key to `env:`:

```yaml
with:
  model: anthropic/<model-id>
  classify_model: opencode/jev-1.13
env:
  ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
  OPENCODE_API_KEY: ${{ secrets.OPENCODE_API_KEY }}
```

## Letting the agent run commands

The agent can always read files. Everything else needs a rule in `allowed_tools`. List each command the job runs by its prefix:

```yaml
with:
  allowed_tools: "Bash(npm ci),Bash(npm test:*),Bash(npm run lint:*)"
```

- `Bash(npm test:*)` allows `npm test` with any arguments; `Bash(npm ci)` allows exactly `npm ci`.
- A command matched by a `Bash(...)` rule must be a single command: `&&`, `;`, `|`, `$()` and redirections are refused, so the agent runs the commands one by one.
- `Edit` and `Write` let agent mode change files. Tag mode can already edit files in the working directory.
- `disallowed_tools` wins over `allowed_tools`, e.g. `allowed_tools: Bash` with `disallowed_tools: "Bash(git push:*)"`.

Plain `Bash` allows every command. Read [Tool permissions](./security.md#tool-permissions) before using it on a job that processes input from people outside your team.

Commands run with the job's environment, so set what they need in the step's `env:`:

```yaml
env:
  ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
  NODE_ENV: test
  DATABASE_URL: postgres://test:test@localhost:5432/test
```

### Scripts (codemode)

pi's `codemode` tool lets the model write a JavaScript script that calls other tools, in parallel if it likes, and passes back only what the script prints. It is off by default, as in pi. Turn it on with:

```yaml
with:
  pi_args: --tools +codemode
```

`codemode` itself needs no rule, but each tool a script calls is checked against `allowed_tools` like a direct call. Scripts can also run classifier and image models with the provider keys in `env:`; no rule covers those calls. See [Tool permissions](./security.md#tool-permissions).

## Instructions for the agent

pi reads these files from the checked-out repository, as it does locally, so project conventions you already keep there apply in the action too:

| Path                             | Effect                                                          |
| -------------------------------- | --------------------------------------------------------------- |
| `AGENTS.md` (or `CLAUDE.md`)     | Project instructions, added to the context                      |
| `.pi/APPEND_SYSTEM.md`           | Appended to pi's system prompt                                  |
| `.pi/SYSTEM.md`                  | Replaces pi's system prompt                                     |
| `.pi/skills/`, `.agents/skills/` | Skills the agent loads when a request matches their description |
| `.pi/prompts/`                   | Prompt templates you run from a comment with `@pi /<name>`      |
| `.pi/extensions/`                | pi extensions, **run as code inside the action**                |

Extensions run with the action's permissions: they can read the provider key and the GitHub token. Only commit extensions you would run in your CI.

The repository's `.pi/settings.json` and `.pi/mcp.json` are not read; see [MCP servers](#mcp-servers). On pull requests, all of these files come from the base branch, not from the pull request; see [Which files come from the base branch](./security.md#which-files-come-from-the-base-branch-on-pull-requests).

For instructions that only apply in CI, use `pi_args`:

```yaml
with:
  pi_args: |
    --append-system-prompt "Answer in the language of the issue. Keep comments under 200 words."
```

`--system-prompt` replaces pi's system prompt instead of appending to it. `--no-context-files` and `--no-skills` stop pi from reading the repository's files.

### Skills from other repositories

`skills` installs [agent skills](https://agentskills.io) from GitHub repositories with [`gh skill install`](https://cli.github.com/manual/gh_skill_install), one per line:

```yaml
with:
  skills: |
    github/awesome-copilot git-commit@v1.2.0
    monalisa/skills-repo skills/monalisa/code-review --pin 3f2a9c1
    my-org/agent-skills --all
```

- Each line is a repository in `OWNER/REPO` form, then a skill name or path (`@version` or `--pin` pins it to a tag or commit), or `--all` for every skill in the repository. `--allow-hidden-dirs` is also accepted.
- Without a version, gh installs the latest release, or the default branch when there is none.
- Skills are installed outside the checkout, so they are never committed with the agent's changes. They are loaded even with `--no-skills` in `pi_args`, which then only drops the repository's own skills.
- gh must be on the runner; GitHub-hosted runners have it. It uses the action's GitHub token, so a private skills repository needs a `github_token` that can read it.

A skill is instructions the agent follows and scripts it may run, written by someone else. Review it before you list it, and pin it so it cannot change under you. The scripts still need `allowed_tools` rules to run.

## Reading CI results

With `actions: read`, the agent gets tools to read workflow runs and job logs on the pull request it works on (`mcp__github_ci__get_ci_status`, `mcp__github_ci__get_workflow_run_details`, `mcp__github_ci__download_job_log`), so `@pi why did CI fail?` works.

```yaml
permissions:
  contents: write
  pull-requests: write
  issues: write
  actions: read
  id-token: write

jobs:
  pi:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: lw396/pi-agent-action@v1
        with:
          model: anthropic/<model-id>
          additional_permissions: |
            actions: read
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

`additional_permissions` adds permissions to the pi-agent-action app token, one `name: level` per line (`actions: read`, `checks: read`, ...). With `github_token`, the token already has its own permissions: grant `actions: read` in the workflow's `permissions:` or in your app instead.

## MCP servers

The agent gets the action's own GitHub servers:

| Server                  | Tools                                                           | Available                                             |
| ----------------------- | --------------------------------------------------------------- | ----------------------------------------------------- |
| `github_comment`        | `update_comment`                                                | Tag mode, or agent mode when `allowed_tools` names it |
| `github_file_ops`       | `commit_files`, `delete_files`                                  | With `use_commit_signing`                             |
| `github_inline_comment` | `create_inline_comment`                                         | On pull requests, when `allowed_tools` names it       |
| `github_ci`             | `get_ci_status`, `get_workflow_run_details`, `download_job_log` | On pull requests, when the token has `actions: read`  |

Address them as `mcp__<server>__<tool>` in `allowed_tools`, e.g. `mcp__github_inline_comment__create_inline_comment` for a review job.

Adding your own MCP servers is not supported yet: the repository's `.mcp.json` is not read, and there is no `--mcp-config` equivalent.

## Branches and comments

```yaml
with:
  trigger_phrase: "@claude" # keep the phrase your team already uses
  label_trigger: ai-fix # label that starts the agent on an issue
  branch_prefix: bot/
  branch_name_template: "{{prefix}}{{entityNumber}}-{{description}}"
  use_sticky_comment: true # one comment per pull request
  exclude_comments_by_actor: "*[bot]" # leave bot comments out of the prompt
```

## Limiting time and cost

There is no turn limit. Bound a run with the job's `timeout-minutes`, keep `allowed_tools` narrow, and pick a cheaper model for routine jobs. The `execution_file` output and the step summary (`display_report: true`) show tokens and cost per run.

```yaml
jobs:
  pi:
    runs-on: ubuntu-latest
    timeout-minutes: 20
```

## Custom Bun

On Nix or in custom containers where the action cannot install Bun, point it at your own:

```yaml
with:
  path_to_bun_executable: /nix/store/.../bin/bun
```

Use the Bun version the action pins (see `action.yml`); others may not work.
