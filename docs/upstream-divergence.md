# 与上游的偏离

本仓库的功能和行为尽量与 [anthropics/claude-code-action](https://github.com/anthropics/claude-code-action)（下称"上游"）保持一致。下文登记每一项偏离，并说明原因。

## 规则

- 只有以下 4 类原因允许偏离：

  | 类别             | 含义                                   |
  | ---------------- | -------------------------------------- |
  | `pi-capability`  | pi 没有某项能力，或者做法不同          |
  | `multi-provider` | 支持多个模型 provider 带来的差异       |
  | `branding`       | 本项目不是官方产品，不使用 Claude 品牌 |
  | `scope`          | 本项目明确不做                         |

- 新增或修改偏离时，同一个 PR 中必须同步更新本清单。没有登记的偏离视为缺陷。
- "用户可见"为"是"的条目，要出现在 README 的迁移对照表中。
- 难以撤回的偏离另写 ADR，在条目中链接过去。
- 从上游 cherry-pick 之前，先在本清单中查一下涉及的区域。
- 每条偏离一个 `####` 标题（领域），按主题放在下面的分组中，格式如下；没有内容的字段省略：

  ```markdown
  #### 领域

  `原因类别` · 用户可见：是 / 否 · ADR：[编号](adr/…)

  - **上游**：……
  - **本仓库**：……
  - **说明**：……
  ```

## 偏离清单

### 执行引擎与输入

#### 执行引擎

`pi-capability` · 用户可见：否 · ADR：[0001](adr/0001-in-process-pi-sdk-runner.md)

- **上游**：Claude Code，通过 Agent SDK 调用
- **本仓库**：pi，在进程内调用 pi SDK（`src/runner/`）
- **说明**：本项目的目的

#### 模型与认证输入

`multi-provider` · 用户可见：是

- **上游**：`anthropic_api_key`、`claude_code_oauth_token`、`use_bedrock` / `use_vertex` / `use_foundry`、workload identity 等
- **本仓库**：`model` 必填；key 按 pi 的变量名通过 workflow `env:` 传入；可选的通用 `api_key`
- **说明**：不为每个 provider 单独设输入。上游 v0.x 曾有 `model` 输入，v1.0 废弃并改为 `claude_args` 中的 `--model`；本仓库恢复同名输入并设为必填，因为没有默认 provider，而 `pi_args` 只放 pi 自己的参数

#### 透传参数

`pi-capability` · 用户可见：是

- **上游**：`claude_args`
- **本仓库**：`pi_args`，只放 pi 自己的参数，且只接受对 action 有意义的一部分（`--thinking`、系统提示词、工具选择、关闭 skills / 提示词模板 / 上下文文件）；其他参数直接报错
- **说明**：参数集不同。pi 在进程内运行，参数由 Runner 用 pi 的 `parseArgs()` 解析后逐项应用；会话、输出模式、资源路径等参数在 action 中没有意义或不安全。`--model`、`--provider`、`--api-key` 改用对应输入。静默忽略会让 workflow 以为生效了。`claude_args` 中常见的 `--max-turns`、`--permission-mode`、`--mcp-config` 没有对应；`--add-dir` 不需要，因为只读工具在任何路径都放行（见"工具规则的语法范围"一条）

#### 仓库的设置文件

`pi-capability` · 用户可见：是

- **上游**：读取仓库的 `.claude/settings.json`（`settingSources` 含 `project`）
- **本仓库**：不读取仓库的 `.pi/settings.json`；Runner 的设置全部在内存中，由 `src/runner/setup-pi-settings.ts` 构造
- **说明**：pi 的内存 `SettingsManager` 没有项目层；`shellPath`、`packages` 等设置能绕开安全默认值。仓库的扩展、skills 和 `AGENTS.md` 不受影响

#### `settings` 输入

`pi-capability` · 用户可见：是

- **上游**：合并写入 `~/.claude/settings.json`
- **本仓库**：删除；Runner 使用内存配置（`src/runner/setup-pi-settings.ts`，目前为空骨架）
- **说明**：格式不兼容；同名输入会让旧配置静默失效；pi 的部分设置能绕开安全默认值

#### 插件输入

`pi-capability` · 用户可见：是

- **上游**：`plugins`、`plugin_marketplaces`
- **本仓库**：删除
- **说明**：pi 没有 Claude Code 的插件市场

#### 已删除的 Claude 专属输入

`pi-capability` · 用户可见：是

- **上游**：输入有效
- **本仓库**：`action.yml` 只保留带 `deprecationMessage` 的占位声明；设置了其中任何一个（包括 `use_bedrock: "false"` 这样的值）时，运行在 prepare 一开始就失败，列出输入名、替代做法和 README 迁移对照表的链接（`src/entrypoints/removed-inputs.ts`）
- **说明**：composite action 读不到未声明的输入，GitHub 只给一条警告；静默忽略会让 workflow 以为配置生效了。涉及的输入：`anthropic_api_key`、`claude_code_oauth_token`、workload identity 的 5 个输入、`use_bedrock` / `use_vertex` / `use_foundry`、`claude_args`、`settings`、`plugins`、`plugin_marketplaces`、`path_to_claude_code_executable`

#### `path_to_claude_code_executable`

`pi-capability` · 用户可见：是 · ADR：[0001](adr/0001-in-process-pi-sdk-runner.md)

- **上游**：跳过安装，使用指定的 Claude Code 可执行文件
- **本仓库**：删除；`path_to_bun_executable` 保留
- **说明**：pi 以 npm 包的形式在 action 进程内运行（ADR-0001），版本由 action 锁定，没有可以替换的可执行文件

#### Claude Code 专用环境变量

`pi-capability` · 用户可见：是（使用遥测的用户）

- **上游**：run 步骤显式传入 `ANTHROPIC_*`、`CLAUDE_CODE_*`、Bedrock / Vertex / Foundry 配置、`MCP_TIMEOUT`、`OTEL_*` 等
- **本仓库**：不再传入；workflow `env:` 中的变量照常到达 pi
- **说明**：pi 不读这些变量。pi 的 provider 读自己的变量（如 `AWS_*`、`GOOGLE_CLOUD_PROJECT`），从 workflow env 传入即可。Claude Code 的遥测（`CLAUDE_CODE_ENABLE_TELEMETRY`、`OTEL_*`）没有对应

#### 脚本调用次数上限（`CLAUDE_CODE_SCRIPT_CAPS`）

`pi-capability` · 用户可见：是（在 workflow `env:` 中设置了 `CLAUDE_CODE_SCRIPT_CAPS` 的用户）

- **上游**：run 步骤传入 workflow env 中的 `CLAUDE_CODE_SCRIPT_CAPS`，Claude Code 按其中的 JSON 限制每个脚本在一次运行中的调用次数
- **本仓库**：不传入，也没有对应机制；设置了也不生效，运行不报错
- **说明**：这是 Claude Code 内部的功能，pi 没有。`allowed_tools` 中的 `Bash(脚本路径:*)` 规则只能决定脚本能否运行，不能限制次数

#### inline comment 分类的 key

`multi-provider` · 用户可见：是

- **上游**：读取 `anthropic_api_key` 输入，调用 Claude Haiku 分类
- **本仓库**：读取 workflow env 中的 `ANTHROPIC_API_KEY`；没有时跳过分类，未确认的 inline comment 全部发布（与上游没有 key 时相同）
- **说明**：`anthropic_api_key` 输入已删除；分类暂时只支持 Anthropic API

#### 触发词、触发标签与分支前缀的默认值

`branding` · 用户可见：是

- **上游**：`@claude`、`claude`、`claude/`
- **本仓库**：`@pi`、`pi`、`pi/`
- **说明**：想保留旧行为，需要显式设置 `trigger_phrase`、`label_trigger`、`branch_prefix`

### 工具与权限

#### 工具权限

`pi-capability` · 用户可见：是

- **上游**：`claude_args` 中的 `--allowedTools` / `--disallowedTools`，加 `--permission-mode auto` 安全审查
- **本仓库**：独立的 `allowed_tools` / `disallowed_tools` 输入，沿用 `Tool(pattern)` 语法，由 `tool_call` 拦截扩展（`src/runner/tool-permissions.ts`）执行，从其他工具发起的嵌套调用也检查。只读工具（Read、Grep、Glob、LS）总是放行；其他调用没有命中 `allowed_tools` 就拒绝，原因返回给模型。没有安全审查
- **说明**：pi 只能按工具名过滤，也没有 auto 模式，未命中规则的调用无法交给审查，所以按 Claude Code 无人值守时（`-p`、`dontAsk`）的做法直接拒绝：不写 `allowed_tools` 时 agent 不能执行 bash，也不能改文件，需要显式写 `Bash`、`Edit`、`Write`。上游 v0.x 曾有同名输入，v1.0 废弃并改为 `claude_args`；本仓库恢复同名输入，因为规则由 action 执行而不是 pi，放在 `pi_args` 中会混入 pi 不认识的参数

#### bash 规则与命令组合

`pi-capability` · 用户可见：是

- **上游**：Claude Code 把 `&&`、`||`、`;`、`|` 等组合拆开，每段分别匹配规则；内置一组只读命令（`ls`、`cat` 等），不需要规则
- **本仓库**：有 `Bash(pattern)` 规则参与判断时，命令中出现 `&&`、`;`、`|`、`&`、换行、`$()`、反引号、`${…}`、`$[…]`、子 shell、重定向或 `$'…'` 就直接拒绝（`$NAME` 不受影响）；没有内置的只读命令集（tag mode 的只读 git 命令除外）。只写 `Bash` 时不检查
- **说明**：拆分要完整实现 bash 的语法，漏掉一种写法就能绕过规则；直接拒绝更容易验证。模型收到原因后可以逐条执行。Tag mode 例外：提示词要用到 `git status`、`git diff`，所以 tag mode 不需要规则就能运行 `git status`、`git diff`、`git log`、`git show`（`src/runner/read-only-git.ts`）。带 `--output`、`--ext-diff`、`--textconv`（含 git 接受的缩写）、全局选项（`-c`、`-C` 等）、变量赋值、`$` 或通配符时不放行

#### 工具规则的语法范围

`pi-capability` · 用户可见：是

- **上游**：Read、Edit 可带路径模式，WebFetch 可带 `domain:`，deny 规则可写 `Tool(param:value)`；只读工具只在工作目录内免授权
- **本仓库**：只有 Bash 规则能带 pattern，其他工具带 pattern 时运行失败；WebFetch、WebSearch 等 pi 没有的工具，规则打印警告后不生效；只读工具在任何路径都放行
- **说明**：静默忽略一个 pattern 会让规则放行或拒绝的范围与写法不一致。pi 的只读工具不区分工作目录，只有 bash 被隔离时，文件工具不能访问 `/proc`（见"文件工具与 `/proc`"一条）

#### Tag mode 的文件编辑

`pi-capability` · 用户可见：否

- **上游**：`--permission-mode acceptEdits`：工作目录内的编辑自动放行，工作目录外拒绝
- **本仓库**：Runner 的 `tool_call` 扩展在工作目录内放行 `edit`、`write`，跟随符号链接判断真实路径；`.git/` 下的写入不放行；`allowed_tools` 中显式的 `Edit`、`Write` 规则在任何路径都放行
- **说明**：pi 没有 acceptEdits 模式。`.git/` 中写入的 hook 会在 `git commit` 时执行任意命令，绕过 bash 规则

### MCP

#### MCP server 注册

`pi-capability` · 用户可见：是（通过 `--mcp-config` 或项目配置添加 MCP server 的用户） · ADR：[0001](adr/0001-in-process-pi-sdk-runner.md)

- **上游**：`--mcp-config` 传入 JSON；Claude Code 另外读取用户和项目的 MCP 配置，`claude_args` 中可以再加 `--mcp-config`
- **本仓库**：通过 SDK 注册，`direct` 暴露模式，不写配置文件；不读取 `~/.pi/agent/mcp.json` 和仓库的 `.pi/mcp.json`；`env` 中的值按字面传给 server（`src/runner/mcp-servers.ts`）
- **说明**：pi 默认的 `codemode` 暴露模式不会直接向模型声明工具。pi 中文件里的同名 server 优先于注册的 server，读取仓库的 `.pi/mcp.json` 会让被 checkout 的代码换掉本项目的 server（例如拿到 GitHub token）。pi 会展开 `env` 值中的 `$NAME` 并执行以 `!` 开头的值，而分支名等值来自仓库，所以一律转义。用户暂时无法添加自己的 MCP server（`pi_args` 不接受相应参数）

#### MCP 工具名

`branding` · 用户可见：是（自定义 prompt 或 `allowed_tools` 中引用了该工具名的用户）

- **上游**：`update_claude_comment`
- **本仓库**：`update_comment`

#### Tag mode 提示词

`pi-capability` · 用户可见：否

- **上游**：让模型"先用 ToolSearch 加载" `update_claude_comment`
- **本仓库**：不提 ToolSearch
- **说明**：pi 没有 ToolSearch；本项目的 MCP 工具以 `direct` 模式直接声明给模型

### 隔离与脱敏

#### bash env 过滤（`allowed_non_write_users`）

`pi-capability` · 用户可见：是 · ADR：[0002](adr/0002-bash-env-allowlist.md)

- **上游**：Claude Code 内置的黑名单，用 workflow `env:` 中的 `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=0` 关闭
- **本仓库**：bash 工具的 `spawnHook` 只传白名单中的变量（`src/runner/env-allowlist.ts` 的 `BASH_ENV_ALLOWLIST`）：`PATH`、`HOME`、`USER`、`LOGNAME`、`SHELL`、`TERM`、`LANG`、`LANGUAGE`、`LC_ALL`、`LC_CTYPE`、`TZ`、`TMPDIR`、`CI`、`RUNNER_OS`、`RUNNER_ARCH`，不含 secret 的 `GITHUB_*`（仓库、ref、run、actor、URL、`GITHUB_EVENT_PATH`、`GITHUB_WORKSPACE`、`GITHUB_ACTION_PATH` 等）、`PWD`、`OLDPWD`，以及 pi 的 `PI_SESSION_ID` 等会话变量；`allowed_bash_env` 输入放行更多变量；`subprocess_isolation: false` 关闭（不再读取 `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`）
- **说明**：上游的黑名单在 Claude Code 内部，拿不到。`GH_TOKEN` 也被去掉，所以 bash 中的 `git push`（凭据 helper 读取 `GH_TOKEN`）和 `gh` 需要在 `allowed_bash_env` 中写上 `GH_TOKEN`，或者改用 `use_commit_signing`。`GITHUB_ENV`、`GITHUB_PATH`、`GITHUB_OUTPUT`、`GITHUB_STATE`、`GITHUB_STEP_SUMMARY` 不在白名单中，写入它们会影响后续步骤

#### bash PID 隔离（`allowed_non_write_users`）

`pi-capability` · 用户可见：是

- **上游**：Claude Code 内置的 bubblewrap 隔离
- **本仓库**：Runner 启动时检测 bwrap，能用时在 `spawnHook` 中把命令包进 bwrap：`--unshare-pid`、新的 `/proc`、`no_new_privs`，文件系统只读，只有工作目录可写，`/tmp` 是空的 tmpfs，网络不隔离；bwrap 不可用（非 Linux、未安装、不能创建 user namespace）时只过滤 env，并输出警告
- **说明**：pi 没有内置沙箱。写 `HOME` 下缓存等工作目录以外的写入会失败

#### 文件工具与 `/proc`（`allowed_non_write_users`）

`pi-capability` · 用户可见：否 · ADR：[0002](adr/0002-bash-env-allowlist.md)

- **上游**：无对应机制
- **本仓库**：bash 被隔离时，`read`、`grep`、`find`、`ls`、`edit`、`write` 的路径（跟随符号链接）落在 `/proc` 下就拒绝；`grep` 搜索包含 `/proc` 的目录（根目录）也拒绝
- **说明**：pi 的文件工具在 pi 进程内执行，不经过 `spawnHook` 和 bwrap，能直接读 `/proc/self/environ`。检查和执行之间被并行的 bash 换掉符号链接的竞争无法排除

#### PR 场景的配置恢复

`pi-capability` · 用户可见：否

- **上游**：`SENSITIVE_PATHS` 只列出 Claude 的配置路径
- **本仓库**：补上 `.pi`、`.agents`、`AGENTS.md`、`AGENTS.MD`、`AGENTS.override.md`、`CLAUDE.MD`
- **说明**：pi 会读取这些路径；上下文文件还接受大写的 `.MD`，在区分大小写的 runner 上是不同的文件

#### 输出脱敏

`multi-provider` · 用户可见：是（评论、step summary 中出现的长 env 值会变成 `[REDACTED]`） · ADR：[0002](adr/0002-bash-env-allowlist.md)

- **上游**：`redactSecrets()` 按格式匹配 GitHub、Anthropic、AWS、Slack、JWT
- **本仓库**：补上 OpenAI、OpenRouter、Google（Gemini）的格式，并新增按值匹配（`src/github/utils/secret-values.ts`）：启动时收集 bash env 白名单以外、长度不少于 16 的 env 值；同时是白名单变量的值、action 从自己的非凭据类输入设置的变量（`ACTION_SETTINGS_ENV`，如 `PROMPT`、`MODEL`；`PI_ARGS` 等透传参数不在其中）、已存在的绝对路径或路径列表除外，把原文、base64（单独编码及嵌在更长内容中的 3 种对齐偏移）和 URL 编码形式替换为 `[REDACTED]`。MCP 工具（action 注册的 server 都与 GitHub 交互，评论类工具在内）的参数在 pi 进程中由 `tool_call` 扩展（`src/runner/comment-redaction.ts`）脱敏后再送到 MCP server。tag mode 生成 prompt 失败、安装 MCP server 失败时的错误信息也经过 `redactSecrets()`（上游没有）
- **说明**：格式未知的 provider（如 OpenCode）只能按值识别。MCP server 进程的 env 中没有 provider key，所以按值脱敏在 pi 进程中完成。workflow 自己设置的、不是密钥的长 env 值（如 URL、不存在的路径）仍会被替换。写进 `prompt` 的 secret 只有在它自己也是 env 变量时才会被识别。post-buffered inline comments 步骤只能看到 job 级 `env:` 中的 key。刻意混淆过的输出挡不住

### 输出与报告

#### 结构化输出

`pi-capability` · 用户可见：是

- **上游**：`claude_args` 中的 `--json-schema`；Claude Code 内部用 StructuredOutput 工具加重试
- **本仓库**：独立的 `json_schema` 输入，根节点必须是 `"type": "object"`；模型调用 `submit_result` 工具提交结果，参数不符合 schema 时错误返回给模型；提交后运行结束。模型没提交就停下时最多提醒 2 次，提醒时只保留 `submit_result`，仍未提交则失败；输出名仍为 `structured_output`
- **说明**：pi 没有 `--json-schema`

#### Execution file 格式

`pi-capability` · 用户可见：是（自行解析 `execution_file` 的用户） · ADR：[0001](adr/0001-in-process-pi-sdk-runner.md)

- **上游**：Claude Agent SDK 的消息数组
- **本仓库**：JSON 数组：pi 的会话头，加上会话事件（不含流式的 `message_update`、`tool_execution_update`），最后一条是本次运行的 token 与 cost 合计（`session_stats`，含 `durationMs`）
- **说明**：事件格式与 pi 的 `--mode json` 一致；`message_end` 中含每次模型响应的 `usage` 和 `cost`。step summary 解析这种格式（见"step summary 内容"一条）。跟踪评论中的耗时读取 `session_stats` 的 `durationMs`

#### step summary 内容

`pi-capability` · 用户可见：是

- **上游**：解析 Claude Agent SDK 消息；结尾的 Final Result 显示 cost 和耗时
- **本仓库**：解析 pi 事件（`message_end`、`tool_execution_end`、`session_stats`）；工具名、参数按 pi 的格式显示；每次模型响应显示含缓存的输入 token；不显示 prompt（会话中唯一的用户消息）；结尾显示轮次、工具调用数、token（含缓存读写）、cost 和耗时；最后一次响应以 `error` / `aborted` 结束时，结尾改为 Error 段落并显示错误信息
- **说明**：格式化在 `src/entrypoints/format-turns.ts`，输出照旧经过 `redactSecrets()`；`display_report: false` 时不写 step summary，与上游一致

#### step summary 标题

`branding` · 用户可见：是

- **上游**：`Claude Code Report`
- **本仓库**：`pi Agent Report`

#### `show_full_output`

`pi-capability` · 用户可见：是

- **上游**：为 `true` 或 env 中 `ACTIONS_STEP_DEBUG=true` 时，把 Claude Agent SDK 的每条消息原样打进 job 日志；否则只打印初始化和结果摘要
- **本仓库**：为 `true` 或 debug 重跑（`core.isDebug()`，即 `RUNNER_DEBUG=1`）时，把写进 Execution file 的每条 pi 事件打进 job 日志，先经过 `redactSecrets()`；否则只打印 token 与 cost 合计和一行提示（`src/runner/run-pi.ts`）
- **说明**：事件格式是 pi 的，与 Execution file 相同。上游原样打印，这里按格式和按值脱敏，但挡不住所有密钥

#### `session_id` 输出

`pi-capability` · 用户可见：是（用 `session_id` 继续会话的用户） · ADR：[0001](adr/0001-in-process-pi-sdk-runner.md)

- **上游**：Claude Code 的会话 ID，会话写在 `~/.claude/` 下，可以用 `--resume` 继续
- **本仓库**：pi 的会话 ID；Runner 的会话只在内存中，不能继续。完整记录在 Execution file 中
- **说明**：不把会话写进 `~/.pi/agent/`；另外 `pi_args` 也不接受 `--session`、`--continue` 等会话参数

### 仓库与 CI

#### `base-action/` 目录

`scope` · 用户可见：否

- **上游**：独立目录，镜像到 `claude-code-base-action` 并作为 npm 包发布
- **本仓库**：删除，执行器放在 `src/runner/`
- **说明**：上游保留独立目录的原因（原为独立仓库、需要镜像、需要发布 npm 包）对本项目都不成立

#### `agent-approval-check` 子 action

`scope` · 用户可见：是（使用 `anthropics/claude-code-action/agent-approval-check` 的用户）

- **上游**：仓库中带有 `agent-approval-check/` 子 action，要求含 agent 提交的 PR 获得 N 个人工 approve
- **本仓库**：删除，没有 `lw396/pi-agent-action/agent-approval-check`
- **说明**：它不调用 agent，与执行引擎无关。需要它的 workflow 继续引用上游的子 action 即可；把 pi 的提交身份加进它的 `agent_emails` / `agent_logins`

#### workflow 加固检查

`pi-capability` · 用户可见：否

- **上游**：`check_workflow_hardening.py` 识别运行 Claude Code action 或提到 `ANTHROPIC_FEDERATION_RULE_ID` 的 job，要求 firewall runner、`--permission-mode auto` 和支持 auto 模式的模型
- **本仓库**：识别运行本 action（`lw396/pi-agent-action`，或带 `pi_args` 输入的本地 action）或提到 `@earendil-works/pi-coding-agent` 的 job；firewall runner 和网络白名单的检查保留；`--permission-mode auto` 检查换成工具白名单检查：`allowed_tools` 中带 `*` 的工具名只能用于 `mcp__` 工具，括号必须配对；豁免表改为 `EXEMPT_FROM_FIREWALL_RUNNER` 和 `EXEMPT_FROM_TOOL_ALLOWLIST`
- **说明**：pi 没有 permission mode，也没有安全审查，工具权限由 `allowed_tools` 规则决定；`*` 这样的工具名会同时放行 bash、edit、write，等于关掉白名单。只检查本仓库的 workflow，不影响使用者
