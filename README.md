![Claude Code Action responding to a comment](https://github.com/user-attachments/assets/1d60c2e9-82ed-4ee5-b749-f9e021c85f4d)

# Claude Code Action

A general-purpose [Claude Code](https://claude.ai/code) action for GitHub PRs and issues that can answer questions and implement code changes. This action intelligently detects when to activate based on your workflow context—whether responding to @claude mentions, issue assignments, or executing automation tasks with explicit prompts. It supports multiple authentication methods including Anthropic direct API (API key or workload identity federation), Amazon Bedrock, Google Vertex AI, and Microsoft Foundry.

## Features

- 🎯 **Intelligent Mode Detection**: Automatically selects the appropriate execution mode based on your workflow context—no configuration needed
- 🤖 **Interactive Code Assistant**: Claude can answer questions about code, architecture, and programming
- 🔍 **Code Review**: Analyzes PR changes and suggests improvements
- ✨ **Code Implementation**: Can implement simple fixes, refactoring, and even new features
- 💬 **PR/Issue Integration**: Works seamlessly with GitHub comments and PR reviews
- 🛠️ **Flexible Tool Access**: Access to GitHub APIs and file operations (additional tools can be enabled via configuration)
- 📋 **Progress Tracking**: Visual progress indicators with checkboxes that dynamically update as Claude completes tasks
- 📊 **Structured Outputs**: Get validated JSON results that automatically become GitHub Action outputs for complex automations
- 🏃 **Runs on Your Infrastructure**: The action executes entirely on your own GitHub runner (Anthropic API calls go to your chosen provider)
- ⚙️ **Simplified Configuration**: Unified `prompt` and `claude_args` inputs provide clean, powerful configuration aligned with Claude Code SDK

## 📦 Upgrading from v0.x?

**See our [Migration Guide](./docs/migration-guide.md)** for step-by-step instructions on updating your workflows to v1.0. The new version simplifies configuration while maintaining compatibility with most existing setups.

## Quickstart

The easiest way to set up this action is through [Claude Code](https://claude.ai/code) in the terminal. Just open `claude` and run `/install-github-app`.

This command will guide you through setting up the GitHub app and required secrets.

**Note**:

- You must be a repository admin to install the GitHub app and add secrets
- This quickstart method is only available for direct Anthropic API users. For AWS Bedrock, Google Vertex AI, or Microsoft Foundry setup, see [docs/cloud-providers.md](./docs/cloud-providers.md).

## 📚 Solutions & Use Cases

Looking for specific automation patterns? Check our **[Solutions Guide](./docs/solutions.md)** for complete working examples including:

- **🔍 Automatic PR Code Review** - Full review automation
- **📂 Path-Specific Reviews** - Trigger on critical file changes
- **👥 External Contributor Reviews** - Special handling for new contributors
- **📝 Custom Review Checklists** - Enforce team standards
- **🔄 Scheduled Maintenance** - Automated repository health checks
- **🏷️ Issue Triage & Labeling** - Automatic categorization
- **📖 Documentation Sync** - Keep docs updated with code changes
- **🔒 Security-Focused Reviews** - OWASP-aligned security analysis
- **📊 DIY Progress Tracking** - Create tracking comments in automation mode

Each solution includes complete working examples, configuration details, and expected outcomes.

## Documentation

- **[Solutions Guide](./docs/solutions.md)** - **🎯 Ready-to-use automation patterns**
- **[Migration Guide](./docs/migration-guide.md)** - **⭐ Upgrading from v0.x to v1.0**
- [Setup Guide](./docs/setup.md) - Manual setup, custom GitHub apps, and security best practices
- [Usage Guide](./docs/usage.md) - Basic usage, workflow configuration, and input parameters
- [Custom Automations](./docs/custom-automations.md) - Examples of automated workflows and custom prompts
- [Configuration](./docs/configuration.md) - MCP servers, permissions, environment variables, and advanced settings
- [Experimental Features](./docs/experimental.md) - Execution modes and network restrictions
- [Cloud Providers](./docs/cloud-providers.md) - AWS Bedrock, Google Vertex AI, and Microsoft Foundry setup
- [Capabilities & Limitations](./docs/capabilities-and-limitations.md) - What Claude can and cannot do
- [Security](./docs/security.md) - Access control, permissions, and commit signing
- [FAQ](./docs/faq.md) - Common questions and troubleshooting

## 📚 FAQ

Having issues or questions? Check out our [Frequently Asked Questions](./docs/faq.md) for solutions to common problems and detailed explanations of Claude's capabilities and limitations.

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
- They currently authenticate to the model API by exchanging a GitHub OIDC token, which act can't mint. Running them locally requires passing an API key as a secret instead, e.g. `--secret ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY"`, and a workflow input that reads it.

## License

This project is licensed under the MIT License—see the LICENSE file for details.
