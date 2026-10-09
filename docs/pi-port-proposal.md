# 提案：将 claude-code-action 改造为 pi-agent-action

> 状态：讨论中 · 创建于 2026-10-06 · 2026-10-07 完成第一轮 grilling，结论已写入各节、[`upstream-divergence.md`](upstream-divergence.md) 和 [`adr/`](adr/)

## 目的

本仓库基于 [anthropics/claude-code-action](https://github.com/anthropics/claude-code-action)（MIT）。目标是把底层执行引擎从 Claude Code 换成 [pi coding agent](https://github.com/earendil-works/pi)，做出一个面向 claude-code-action 用户的 **即插即用替代品**：

> **对 claude-code-action 用户迁移改动有限且可列举，任意模型可用，安全默认值不打折。**

- **迁移改动有限且可列举**：与 GitHub 相关的输入、触发方式、评论与分支行为与上游对齐；必须改的每一行都列在迁移对照表中。例如触发词默认改为 `@pi`，想保留 `@claude` 的用户要显式设置 `trigger_phrase`。
- **任意模型**：借助 pi 的多 provider 支持（Anthropic、OpenAI、Gemini、Bedrock、Vertex、自定义 provider 等），不再绑定 Anthropic。
- **安全默认值不打折**：保留上游的写权限校验、GitHub App token 生命周期管理、secret 清理与 workflow 加固检查，并补齐 pi 缺少的权限控制。

本项目不是 Anthropic 或 pi 的官方产品。

## 背景：为什么现在可行

pi 在 2026-10-02 发布了 1.0 版本，内置了 MCP 支持（参见 `packages/coding-agent/docs/mcp.md`）：

- 支持 stdio 和 streamable HTTP 两种 server，配置可以写在 `~/.pi/agent/mcp.json`（用户级）或 `.pi/mcp.json`（项目级，需要 project trust），也可以在 SDK 中用 `pi.registerMcpServer()` 注册。
- **工具命名同样是 `mcp__<server>__<tool>`**，和 Claude Code 一致，所以现有提示词中的 `mcp__github_*` 引用基本不用改。
- 工具暴露模式有 `codemode`（默认）、`deferred`、`direct`、`hidden` 四种，可以按 server 或按工具单独配置（`toolExposure`）。
- 提供 TypeScript SDK（`createAgentSession()`），以及 JSON 和 RPC 运行模式。
- 用 `--tools` / `--exclude-tools`（SDK 中对应 `tools` / `excludeTools`）限制可用工具，支持通配符。扩展可以通过 `tool_call` 事件返回 `{ block: true, reason }` 来拦截工具调用。
- **没有逐次批准机制，也没有类似 Claude Code `--permission-mode auto` 的安全审查。**

## 竞品调研（2026-10-06）

| 项目                                                                                 | 概况                                                                                                                                 | 与本项目的差异                                                                                                                                               |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [shaftoe/pi-coding-agent-action](https://github.com/shaftoe/pi-coding-agent-action)  | 约 76 star，v2.30.0，功能完整：`/pi` 触发、进度评论、分支和 PR、行内 review、CI 工具、MCP、cost 输出、会话分享，并兼容 Forgejo/Gitea | 输入约定是自己的一套，不兼容 claude-code-action；CI 中默认 `projectTrusted: true`，会加载被 checkout 仓库里的 `.pi/` 扩展；需要用户自己提供 PAT 或 App token |
| [cv/pi-action](https://github.com/cv/pi-action)                                      | 约 41 star，`@pi` 触发，有用户白名单和输入清洗                                                                                       | 功能较少，没有提到行内评论、CI 状态和 MCP                                                                                                                    |
| [gh-agent-pi](https://github.com/marketplace/actions/gh-agent-pi)                    | v0.1.2，早期阶段                                                                                                                     | 面向个人开发者的轻量方案                                                                                                                                     |
| [GitHub Agentic Workflows 的 pi engine](https://github.github.com/gh-aw/engines/pi/) | GitHub 官方的 gh-aw 框架                                                                                                             | 定位是用 Markdown 编写的定时或事件驱动自动化，不是 `@mention` 对话式机器人                                                                                   |

**本项目的差异化**，按重要性排序：

1. 与 claude-code-action 的输入和行为兼容，迁移成本最低。
2. 安全默认值：触发者写权限校验；PR 场景下从目标分支恢复 `.pi/` 等配置；`allowed_non_write_users` 场景下 bash 使用 env 白名单并在 bwrap 中运行；workflow 加固检查。
3. GitHub App OIDC 换取 token，并在 `always()` 步骤中吊销。
4. 行内评论先缓冲、分类后再发布（`classify_inline_comments`），支持 sticky comment 和 commit 签名（SSH 或 API）。
5. 上游打磨过的提示词构建：评论过滤、按 actor 包含或排除等。

需要注意的风险：竞品迭代很快，功能差距可能很快缩小。护城河应该是"兼容加安全"，而不是"功能多"。

## 代码改造评估

全仓库约 1.1 万行 TypeScript，大部分和模型无关。

| 模块                                                                          | 处理方式                                                                                                                                                                                 | 工作量 |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `src/github/*`、`src/modes/detector.ts`、触发检测、分支和评论创建             | 保留，默认值改为 `@pi`、`pi/`；`restore-config.ts` 的 `SENSITIVE_PATHS` 补上 `.pi`、`.agents`、`AGENTS.md`、`AGENTS.MD`、`AGENTS.override.md`、`CLAUDE.MD`                               | 小     |
| `src/mcp/*`（5 个 MCP server）                                                | **原样复用**，`install-mcp-server.ts` 改为通过 SDK 注册（`direct` 暴露模式，不写配置文件）                                                                                               | 小     |
| `src/create-prompt/index.ts`                                                  | 基本保留；`update_claude_comment` 改名为 `update_comment`，批量替换                                                                                                                      | 小     |
| `base-action/src/run-claude-sdk.ts`、`parse-sdk-options.ts`                   | 改为使用 pi SDK：`createAgentSession()` 加 `session.subscribe()`，通过 `extensionFactories` 加载 `createMcpExtension()`（见 ADR-0001）                                                   | 中     |
| `src/entrypoints/format-turns.ts`                                             | 改为解析 pi 的事件（`message_end`、`tool_execution_*`、`agent_settled`）                                                                                                                 | 中     |
| `src/modes/agent/parse-tools.ts`                                              | 改为解析新的 `allowed_tools` / `disallowed_tools` 输入（沿用 Claude 的 `Tool(pattern)` 语法），映射到 pi 工具名                                                                          | 小     |
| 权限模型                                                                      | 新增 `tool_call` 拦截扩展，按 `allowed_tools` 规则检查 bash 命令；解析 shell 语法，拒绝 `&&`、`;`、`\|`、`$()` 等组合；替代 `--permission-mode`                                          | 中     |
| structured output（`--json-schema`）                                          | pi 没有原生支持；新增 `json_schema` 输入，用 `submit_result` tool 接收结果，`agent_before_settle` 中最多提醒 2 次，仍未提交则失败                                                        | 中     |
| `install-plugins.ts`、`setup-claude-code-settings.ts`、`workload-identity.ts` | 删除；`setup-claude-code-settings.ts` 改为 `src/runner/setup-pi-settings.ts` 空骨架（返回内存配置，暂不设置任何项）                                                                      | 小     |
| `action.yml`                                                                  | 重新设计 Claude 专属输入（见下文）                                                                                                                                                       | 中     |
| `.github/scripts/check_workflow_hardening.py`                                 | 去掉 `--permission-mode auto` 检查，改为检查工具白名单（已完成，#15）。project trust 不用检查：`settings` 输入已删除，Runner 也不读取仓库的 `.pi/settings.json`，workflow 没有办法设置它 | 小     |
| bash 子进程隔离（`allowed_non_write_users`）                                  | `createBashTool()` 的 `spawnHook`：env 白名单加 bwrap（PID namespace、`no_new_privs`）；bwrap 不可用时只做 env 白名单（见 ADR-0002）                                                     | 中     |
| 输出脱敏（`src/github/utils/sanitizer.ts`）                                   | 补上主流 provider 的格式正则；新增按值匹配（独立文件），评论类工具在 `tool_call` 扩展中改写参数                                                                                          | 小     |

**估算**：可用版本约 1 周，功能基本对等约 2 周。

### 接入 MCP 时的注意事项

- 我们的 server 必须设为 `direct` 暴露。默认的 `codemode` 不会向模型直接声明工具，和提示词中"直接调用某工具"的指令对不上。
- 本项目的 server 通过 SDK 注册，不写 `~/.pi/agent/mcp.json`，避免 GitHub token 落盘。
- 仓库自带的 `.pi/` 配置与上游处理 `.claude/` 的方式一致：默认加载；PR 场景下先由 `restore-config.ts` 恢复成目标分支的版本（见"安全"第 4 项）。
- SDK 模式下 MCP 不会自动启用，要显式加入 `createMcpExtension()`，然后调用 `session.bindExtensions()`。

### 待实测确认

- `toolExposure` 的具体配置格式
- ~~SDK 中 usage/cost 的字段~~ 已确认：事件中的 `usage`，含 `cost.total` 等（pi `json.md`）
- JSON 模式的退出码约定
- `SettingsManager.inMemory()` 的签名
- 会话中途切换可用工具集（structured output 重试时只保留 `submit_result`）
- `restore-config.ts` 能否正确处理新增的 pi 路径
- `spawnHook` 改写后的 command 在 bwrap 中的实际表现（`/proc`、`sudo`、`no_new_privs`）

## `action.yml` 输入兼容策略

- **保持一样**：`trigger_phrase`、`prompt`、`label_trigger`、`assignee_trigger`、`base_branch`、`branch_prefix`、`branch_name_template`、`allowed_bots`、`allowed_non_write_users`、`include_comments_by_actor`、`exclude_comments_by_actor`、`github_token`、`use_sticky_comment`、`track_progress`、`use_commit_signing`、`ssh_signing_key`、`additional_permissions`、`classify_inline_comments` 等与 GitHub 相关的输入。
- **必须替换**：`claude_args` → `pi_args`（只放 pi 自己的参数）；所有认证相关输入（见下文"模型与认证"）。
- **删除**：`path_to_claude_code_executable`、插件相关输入。设置已删除的输入时运行失败，并指向迁移对照表（`src/entrypoints/removed-inputs.ts`）。
- **删除**：`settings`。上游常见的 key 都有了新位置（`model` → `model` 输入，`env` → workflow 的 `env:`，`permissions` → `allowed_tools`）；同名但改收 pi 格式会让旧配置静默失效；pi 的部分设置（`defaultProjectTrust`、`packages`、`shellPath`）能绕开安全默认值。以后有需要再加 `pi_settings`。
- **新增**：`model`（必填）、`api_key`（可选）、`allowed_tools` / `disallowed_tools`（沿用 Claude 语法）、`json_schema`（输出仍叫 `structured_output`），以及 bash env 白名单的放行输入 `allowed_bash_env` 和关闭开关 `subprocess_isolation`。
- **更换默认值**：触发词 `@claude` → `@pi`，触发标签 `claude` → `pi`，分支前缀 `claude/` → `pi/`；`bot_name` / `bot_id` 由 GitHub App 决定，待定。

README 中要提供一张 claude-code-action → pi-agent-action 的迁移对照表，内容从 [`upstream-divergence.md`](upstream-divergence.md) 中挑出用户可见的条目。

### 模型与认证：不设默认 provider，直接沿用 pi 的约定

pi 支持 30 多个 provider，每个 provider 从自己的环境变量读取 key，例如 `ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`GEMINI_API_KEY`、`OPENROUTER_API_KEY`、`OPENCODE_API_KEY`。pi 文档也推荐 CI 用环境变量提供 key。

模型通过 `--model` 选择，格式是 `provider/id`，可以加 `:<thinking>` 后缀；`--provider` 用来把查找限定在某一个 provider 内。凭据的优先级从高到低是：运行时 `--api-key` > `auth.json` > `models.json` 中的 `apiKey` > 环境变量。

据此，action 对 provider 保持中立，不选定任何默认 provider：

```yaml
- uses: lw396/pi-agent-action@v1
  with:
    model: opencode/<model-id> # 必填，格式是 provider/id
  env:
    OPENCODE_API_KEY: ${{ secrets.OPENCODE_API_KEY }} # 用哪家就传哪家的变量
```

- **`model` 设为必填**。pi 文档没有说明不指定模型时会选哪个，CI 不能依赖不确定的行为。必填也就不存在"默认用哪家"的问题。
- **不为每个 provider 单独设输入**。上游的 `anthropic_api_key`、`claude_code_oauth_token`、`use_bedrock`、`use_vertex`、`use_foundry`，以及 Anthropic workload identity federation 的 `anthropic_federation_rule_id` 等输入全部删除。用户按 pi 的变量名通过 `env` 传 key。
- **可选的通用 `api_key` 输入**：对应 pi 的 `--api-key`，供只想配置一个 secret 的用户使用。它要求同时设置 `model`。
- Bedrock、Vertex 等云平台凭据，按 pi 的方式从环境中获取（例如 AWS 环境凭据、Google ADC），action 不再处理 OIDC 换取凭据。是否提供示例 workflow，到 M4 再决定。

## 安全

上游的防护分三层：egress firewall runner、网络白名单、`--permission-mode auto` 安全审查。在 `allowed_non_write_users` 场景下，Claude Code 还会用内置的一百多项黑名单清理子进程 env，并在 Linux 上用 bubblewrap 做 PID namespace 隔离（`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`）。

pi 没有内置沙箱，也没有安全审查，但 `createBashTool()` 的 `spawnHook` 可以改写 bash 的 env 和 command。替代方案如下：

1. **网络**：继续使用 egress firewall runner 和网络白名单。
2. **工具权限**：`allowed_tools` / `disallowed_tools` 输入沿用 Claude 的 `Tool(pattern)` 语法，由 `tool_call` 拦截扩展执行。bash 规则要解析 shell 语法，遇到 `&&`、`;`、`|`、`$()`、反引号等组合直接拒绝，避免 `git add . && curl …` 这类前缀绕过。tag mode 默认的 git 命令白名单也走这套机制。
3. **bash 子进程隔离（`allowed_non_write_users` 场景）**：
   - env 用**白名单**：只传 `PATH`、`HOME`、`LANG`、`CI`、非敏感的 `GITHUB_*` 等，其余一律不传；用户脚本需要的变量通过输入显式放行（见 ADR-0002）。
   - 命令包在 bwrap 中运行（`--unshare-pid`、新的 `/proc`、`no_new_privs`），防止通过 `cat /proc/$PPID/environ` 或 `sudo` 读取 pi 进程和 MCP server 的 env。
   - bwrap 不可用（macOS/Windows runner、没有 sudo 的自托管 runner、`container:` 作业）时与上游一致：只做 env 白名单，bash 照常可用，并在 `docs/security.md` 中写明这种情况下可以被绕过。
   - 保留上游与执行引擎无关的步骤：固定 bun 路径，在 `always()` 步骤中重新把系统目录加到 PATH 前面。
4. **仓库配置**：与上游一致，默认加载仓库中的配置；PR 场景下先用 `restore-config.ts` 把 `SENSITIVE_PATHS` 恢复成目标分支的版本。列表在上游的基础上补上 `.pi`、`.agents`、`AGENTS.md`、`AGENTS.MD`、`AGENTS.override.md`、`CLAUDE.MD`（pi 也读取大写的 `.MD` 上下文文件）。
5. **输出脱敏**：上游的 `redactSecrets()` 按格式匹配，只认识 GitHub、Anthropic、AWS、Slack 和 JWT。补上主流 provider 的格式，并新增按值匹配：启动时收集白名单以外、长度不少于 16 的 env 值，在要发出的文本中查找原文、base64 和 URL 编码形式。评论类工具在 pi 进程中由 `tool_call` 扩展改写参数；step summary 和错误信息在 action 进程中处理。两种方式都挡不住刻意混淆过的输出，只是额外的一层。
6. **凭据不落盘**：本项目的 MCP server 通过 SDK 注册，pi 的设置使用内存中的 `SettingsManager`，不写 `~/.pi/agent/` 下的文件。

第 2 项替代的是 `--permission-mode auto` 的安全审查，做不到同等的防护，这是相对上游的实质性降级，需要在 `docs/security.md` 中如实说明。

## 非目标

- 不支持 Forgejo、Gitea、Codeberg 等非 GitHub 平台。OIDC App token、`always()` 步骤吊销 token、workflow 加固检查都是 GitHub 专属的；做多平台会让 `src/github/*` 偏离上游，冲淡"兼容加安全"这条护城河。

## 仓库与上游同步

- `lw396/pi-agent-action` 已于 2026-10-06 通过 "Leave fork network" 脱离 fork 关系，成为独立仓库，完整 git 历史仍保留。
- 本地保留 `upstream` remote 指向 `anthropics/claude-code-action`。同步方式：

  ```bash
  git fetch upstream
  git log --oneline main..upstream/main | grep -v "chore: bump"
  git cherry-pick <sha>
  ```

  上游 2026-07 以来的 50 个提交中，有 43 个是自动版本升级，跟进成本很低。

- **对齐原则**：功能和行为尽量与上游一致。只有 4 类原因允许偏离：`pi-capability`（pi 没有或做法不同的能力）、`multi-provider`（支持多个 provider 带来的差异）、`branding`（非官方产品，不使用 Claude 品牌）、`scope`（明确不做）。每一项偏离都登记在 [`upstream-divergence.md`](upstream-divergence.md) 中；cherry-pick 之前先查这份清单。
- 尽量保持 `src/github/*`、`src/mcp/*` 的结构不变，方便 cherry-pick；Claude 专属部分可以放手重写。
- pi 依赖锁定精确版本，用 Renovate/Dependabot 发升级 PR，升级 PR 要跑集成测试。
- `base-action/` 不再作为独立包发布，也不再保持独立目录。上游把它放在独立目录，是因为它原本是一个独立仓库（2025-07 通过 `8335bda` 并入），之后又要镜像同步到 `anthropics/claude-code-base-action`，还要作为 npm 包发布。这几个原因对本项目都不成立。pi 执行器放在 `src/runner/`，`base-action/` 中通用的部分（`prepare-prompt.ts`、`retry.ts`、`execution-file.ts`）迁移过去，等没有代码再引用它后，整个目录删除。
- 命名、图标、Marketplace 描述中不使用 "Claude"。README 中注明 "Based on anthropics/claude-code-action (MIT)"，并声明本项目不是官方产品。

## CI 与集成测试

### 现状（M0 起）

- `ci-all.yml` 在推送到 `main`、提交 PR 和手动触发时**自动运行**，但只调用 `ci.yml`，也就是单元测试、Prettier 格式检查和 typecheck。
- `workflow-hardening.yml` 照常在 PR 和推送到 `main` 时自动运行。
- 5 个集成测试 `test-*.yml` **只能手动触发**，也不再被 `ci-all.yml` 调用。原因：

  - 它们测试的仍是 Claude 执行器；
  - 它们通过 Anthropic workload identity federation 认证，本仓库没有相应配置；
  - 它们依赖的 `ubuntu-24.04-firewall` runner 在个人账号下很可能不可用。

  在这种状态下自动运行，结果只会是失败。

### 目标：移植完成后恢复自动运行

集成测试是唯一会真正调用模型、端到端验证执行器的测试。单元测试覆盖不到这部分，所以每个 `test-*.yml` 移植到 pi 后，都要**恢复 `pull_request` 和 `workflow_call` 触发，并重新加回 `ci-all.yml`**。各工作流的处理时机如下：

| 工作流                        | 测试内容                                                    | 处理方式                                                 | 恢复自动运行的时机 |
| ----------------------------- | ----------------------------------------------------------- | -------------------------------------------------------- | ------------------ |
| `test-base-action.yml`        | 用内联 prompt 或 prompt 文件运行执行器，检查 execution file | 改为测试 `src/runner/` 的 pi 执行器                      | M1                 |
| `test-mcp-servers.yml`        | MCP server 能否被加载、调用                                 | 改为验证 pi 以 `direct` 模式加载本项目的 MCP server      | M2                 |
| `test-structured-output.yml`  | `--json-schema` 结构化输出                                  | 改为测试基于自定义 tool 的 structured output             | M3                 |
| `test-settings.yml`           | Claude Code `settings` 输入                                 | 随 `settings` 输入一起删除                               | M4                 |
| `test-custom-executables.yml` | 自定义 Claude Code、Bun 可执行文件路径                      | 随 `path_to_claude_code_executable` 等输入一起删除或改写 | M4                 |

恢复自动运行前，需要满足以下条件：

1. **认证**：仓库 secret 中已有 `OPENCODE_API_KEY`（2026-10-07 添加），工作流通过 `env` 传入它，不再用 Anthropic 联邦认证。
2. **fork PR**：来自 fork 的 PR 拿不到 secret，所以保留"仅同仓库 PR 才运行"的 `if` 条件，fork PR 跳过集成测试。
3. **runner 与加固检查**：确认 `ubuntu-24.04-firewall` 是否可用。
   - 如果不可用，要么改用其他方式限制出站流量，要么把相关 job 连同原因写进 `check_workflow_hardening.py` 的豁免表。不能直接关闭检查。
   - 加固检查的识别规则已从 Claude 改为 pi（#15）。
4. **成本控制**：集成测试使用低价模型，限制最大轮数。必要时用 `paths` 过滤，只在执行器、MCP 或 `action.yml` 发生变化时运行。

## 里程碑

0. **M0 — 准备**：`ci-all.yml` 只调用单元测试、格式检查和类型检查，集成测试暂时改为只能手动触发（见"CI 与集成测试"）；更新 `CLAUDE.md`；做技术验证，确认 pi SDK 能在 Bun 下运行，MCP 的 `direct` 暴露模式可用，并找到 usage/cost 字段；确定命名，以及集成测试用的模型。
1. **M1 — agent mode 跑通**：在 `src/runner/` 中用 pi SDK 执行 `prompt`，并输出 execution file；锁定 pi 精确版本并配置 Renovate/Dependabot；新建 `setup-pi-settings.ts` 空骨架；`test-base-action.yml` 恢复自动运行。（2–3 天）
2. **M2 — tag mode 跑通**：现有 MCP server 以 `direct` 模式注册，跟踪评论、分支、提交都正常工作；`update_claude_comment` 改名为 `update_comment`；`SENSITIVE_PATHS` 补上 pi 路径；`test-mcp-servers.yml` 恢复自动运行。（2–3 天）
3. **M3 — 安全与控制**：`allowed_tools` 与 `tool_call` 拦截扩展、bash 子进程隔离（env 白名单加 bwrap）、输出脱敏、structured output（`json_schema` 输入）；`test-structured-output.yml` 恢复自动运行。
4. **M4 — 收尾**：重写 `format-turns.ts`，迁移 `action.yml` 输入，更新加固检查脚本，删除 `test-settings.yml`，处理 `test-custom-executables.yml`，补充迁移对照表和文档。

## 待决问题

- ~~是否修改 `update_claude_comment` 等 MCP 工具名？~~ 已决定：改为 `update_comment`，写进迁移表。
- ~~默认 provider 和 model 用什么？~~ 已决定：不设默认 provider，`model` 必填（见"模型与认证"）。开发和集成测试使用仓库 secret `OPENCODE_API_KEY`（OpenCode Zen/Go）；具体用哪个模型，在技术验证时从 OpenCode 的可用模型里挑一个便宜的。
- ~~是否支持 Codeberg、Forgejo 等非 GitHub 平台？~~ 已决定：不支持，见"非目标"。
- ~~`allowed_non_write_users` 场景下是否直接禁用 bash？~~ 已决定：不禁用，改用 env 白名单加 bwrap 隔离，见"安全"第 3 项。
- `bot_name` / `bot_id` 的默认值（取决于 GitHub App 的名称）。
- ~~bash env 白名单的具体变量清单，以及放行输入的名称。~~ 已决定：清单见 `src/runner/env-allowlist.ts` 的 `BASH_ENV_ALLOWLIST`，放行输入为 `allowed_bash_env`，关闭开关为 `subprocess_isolation: false`。
- ~~`path_to_claude_code_executable` 删除还是改写？~~ 已决定：删除，pi 在 action 进程内运行，没有可以替换的可执行文件；使用已删除的输入时运行失败，并指向 README 的迁移对照表。

## 参考

- pi 文档：[mcp](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md) · [sdk](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md) · [json](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/json.md) · [extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md) · [security](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md) · [providers](https://pi.dev/docs/latest/providers#use-an-api-key-from-the-environment) · [models](https://pi.dev/docs/latest/models) · [cli](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/cli.md)
- [The Register: Pi coding agent pulls a 180 and adds MCP support](https://www.theregister.com/ai-and-ml/2026/10/02/pi-coding-agent-pulls-a-180-and-adds-mcp-support/5300678)
- [GitHub Docs: Detaching a fork](https://docs.github.com/en/pull-requests/how-tos/work-with-forks/detaching-a-fork)
