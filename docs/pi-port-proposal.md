# 提案：将 claude-code-action 改造为 pi-agent-action

> 状态：讨论中 · 创建于 2026-10-06

## 目的

本仓库基于 [anthropics/claude-code-action](https://github.com/anthropics/claude-code-action)（MIT）。目标是把底层执行引擎从 Claude Code 换成 [pi coding agent](https://github.com/earendil-works/pi)，做出一个面向 claude-code-action 用户的 **即插即用替代品**：

> **对 claude-code-action 用户迁移零成本，任意模型可用，安全默认值不打折。**

- **迁移零成本**：与 GitHub 相关的输入、触发方式、评论与分支行为保持一致，现有 workflow 只需改少量几行即可切换。
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
2. 安全默认值：触发者写权限校验；默认不信任仓库 `.pi/` 配置；`allowed_non_write_users` 场景下清理 secret；workflow 加固检查。
3. GitHub App OIDC 换取 token，并在 `always()` 步骤中吊销。
4. 行内评论先缓冲、分类后再发布（`classify_inline_comments`），支持 sticky comment 和 commit 签名（SSH 或 API）。
5. 上游打磨过的提示词构建：评论过滤、按 actor 包含或排除等。

需要注意的风险：竞品迭代很快，功能差距可能很快缩小。护城河应该是"兼容加安全"，而不是"功能多"。

## 代码改造评估

全仓库约 1.1 万行 TypeScript，大部分和模型无关。

| 模块                                                                          | 处理方式                                                                                                                | 工作量 |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------ |
| `src/github/*`、`src/modes/detector.ts`、触发检测、分支和评论创建             | 保留，只调整 `@claude`、`claude/` 等默认值                                                                              | 小     |
| `src/mcp/*`（5 个 MCP server）                                                | **原样复用**，`install-mcp-server.ts` 改为生成 pi 的配置（`direct` 暴露模式）                                           | 小     |
| `src/create-prompt/index.ts`                                                  | 基本保留；如果 `update_claude_comment` 等工具改名，就批量替换                                                           | 小     |
| `base-action/src/run-claude-sdk.ts`、`parse-sdk-options.ts`                   | 改为使用 pi SDK：`createAgentSession()` 加 `session.subscribe()`，通过 `extensionFactories` 加载 `createMcpExtension()` | 中     |
| `src/entrypoints/format-turns.ts`                                             | 改为解析 pi 的事件（`message_end`、`tool_execution_*`、`agent_settled`）                                                | 中     |
| `src/modes/agent/parse-tools.ts`                                              | 改为映射到 pi 的 `tools` / `excludeTools`                                                                               | 小     |
| 权限模型                                                                      | 新增 `tool_call` 拦截扩展（例如 bash 命令白名单），替代 `--permission-mode`                                             | 中     |
| structured output（`--json-schema`）                                          | pi 没有原生支持；用自定义 `submit_result` tool 实现                                                                     | 中     |
| `install-plugins.ts`、`setup-claude-code-settings.ts`、`workload-identity.ts` | 删除，或改为 pi 的 provider 配置                                                                                        | 小     |
| `action.yml`                                                                  | 重新设计 Claude 专属输入（见下文）                                                                                      | 中     |
| `.github/scripts/check_workflow_hardening.py`                                 | 去掉 `--permission-mode auto` 检查，改为检查工具白名单和 project trust                                                  | 小     |

**估算**：可用版本约 1 周，功能基本对等约 2 周。

### 接入 MCP 时的注意事项

- 我们的 server 必须设为 `direct` 暴露。默认的 `codemode` 不会向模型直接声明工具，和提示词中"直接调用某工具"的指令对不上。
- **不要使用项目级 `.pi/mcp.json`，也不要在 CI 中使用 `--approve`**。否则被 checkout 的仓库中的扩展会被加载执行。应该写入用户级配置或通过 SDK 注册，并显式使用 `--no-approve` 或等价的 SDK 设置。
- SDK 模式下 MCP 不会自动启用，要显式加入 `createMcpExtension()`，然后调用 `session.bindExtensions()`。

### 待实测确认

- `toolExposure` 的具体配置格式
- SDK 中 usage/cost 的字段
- JSON 模式的退出码约定

## `action.yml` 输入兼容策略

- **保持一样**：`trigger_phrase`、`prompt`、`label_trigger`、`assignee_trigger`、`base_branch`、`branch_prefix`、`branch_name_template`、`allowed_bots`、`allowed_non_write_users`、`include_comments_by_actor`、`exclude_comments_by_actor`、`github_token`、`use_sticky_comment`、`track_progress`、`use_commit_signing`、`ssh_signing_key`、`additional_permissions`、`classify_inline_comments` 等与 GitHub 相关的输入。
- **必须替换**：`claude_args` → `pi_args`；`anthropic_api_key` / `claude_code_oauth_token` → `provider` + `model` + 对应的 API key；`settings`；`path_to_claude_code_executable`；插件相关输入；Anthropic workload identity federation 相关输入。
- **建议更换默认值**：`@claude` 触发词、`claude/` 分支前缀、`bot_name` / `bot_id`。

README 中要提供一张 claude-code-action → pi-agent-action 的迁移对照表。

## 安全

上游依赖三层防护：egress firewall runner、网络白名单、`--permission-mode auto`。pi 中没有第三层的直接对应，替代方案如下：

1. 继续使用 egress firewall runner 和网络白名单。
2. 用 `tools` / `excludeTools` 只开放需要的工具。
3. 通过 `tool_call` 拦截扩展限制 bash 等高风险工具。
4. 默认不信任仓库自带的 `.pi/` 配置和扩展。

这是相对上游的实质性降级，需要在 `docs/security.md` 中如实说明。

## 仓库与上游同步

- `lw396/pi-agent-action` 已于 2026-10-06 通过 "Leave fork network" 脱离 fork 关系，成为独立仓库，完整 git 历史仍保留。
- 本地保留 `upstream` remote 指向 `anthropics/claude-code-action`。同步方式：

  ```bash
  git fetch upstream
  git log --oneline main..upstream/main | grep -v "chore: bump"
  git cherry-pick <sha>
  ```

  上游 2026-07 以来的 50 个提交中，有 43 个是自动版本升级，跟进成本很低。

- 尽量保持 `src/github/*`、`src/mcp/*` 的结构不变，方便 cherry-pick；Claude 专属部分可以放手重写。
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
| `test-settings.yml`           | Claude Code `settings` 输入                                 | 如果保留 `settings` 输入，就改为测试 pi 的设置；否则删除 | M4                 |
| `test-custom-executables.yml` | 自定义 Claude Code、Bun 可执行文件路径                      | 随 `path_to_claude_code_executable` 等输入一起删除或改写 | M4                 |

恢复自动运行前，需要满足以下条件：

1. **认证**：在仓库 secret 中配置一个模型 API key，工作流改用 API key 认证，不再用 Anthropic 联邦认证。
2. **fork PR**：来自 fork 的 PR 拿不到 secret，所以保留"仅同仓库 PR 才运行"的 `if` 条件，fork PR 跳过集成测试。
3. **runner 与加固检查**：确认 `ubuntu-24.04-firewall` 是否可用。
   - 如果不可用，要么改用其他方式限制出站流量，要么把相关 job 连同原因写进 `check_workflow_hardening.py` 的豁免表。不能直接关闭检查。
   - 同时把加固检查的识别规则从 Claude 改为 pi（M3/M4）。
4. **成本控制**：集成测试使用低价模型，限制最大轮数。必要时用 `paths` 过滤，只在执行器、MCP 或 `action.yml` 发生变化时运行。

## 里程碑

0. **M0 — 准备**：`ci-all.yml` 只调用单元测试、格式检查和类型检查，集成测试暂时改为只能手动触发（见"CI 与集成测试"）；更新 `CLAUDE.md`；做技术验证，确认 pi SDK 能在 Bun 下运行，MCP 的 `direct` 暴露模式可用，并找到 usage/cost 字段；确定默认的 provider、model 和命名。
1. **M1 — agent mode 跑通**：在 `src/runner/` 中用 pi SDK 执行 `prompt`，并输出 execution file；`test-base-action.yml` 恢复自动运行。（2–3 天）
2. **M2 — tag mode 跑通**：现有 MCP server 以 `direct` 模式注册，跟踪评论、分支、提交都正常工作；`test-mcp-servers.yml` 恢复自动运行。（2–3 天）
3. **M3 — 安全与控制**：工具白名单映射、`tool_call` 拦截扩展、structured output、默认不信任项目配置；`test-structured-output.yml` 恢复自动运行。
4. **M4 — 收尾**：重写 `format-turns.ts`，迁移 `action.yml` 输入，更新加固检查脚本，处理 `test-settings.yml` 和 `test-custom-executables.yml`，补充迁移对照表和文档。

## 待决问题

- 是否修改 `update_claude_comment` 等 MCP 工具名？改名的话命名更中立，但会和上游的提示词产生差异。
- 默认 provider 和 model 用什么？
- 是否支持 Codeberg、Forgejo 等非 GitHub 平台？（竞品已经支持。）
- `allowed_non_write_users` 场景下，没有 auto 模式的安全审查，是否应该直接禁用 bash？

## 参考

- pi 文档：[mcp](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md) · [sdk](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md) · [json](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/json.md) · [extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md) · [security](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md) · [providers](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md)
- [The Register: Pi coding agent pulls a 180 and adds MCP support](https://www.theregister.com/ai-and-ml/2026/10/02/pi-coding-agent-pulls-a-180-and-adds-mcp-support/5300678)
- [GitHub Docs: Detaching a fork](https://docs.github.com/en/pull-requests/how-tos/work-with-forks/detaching-a-fork)
