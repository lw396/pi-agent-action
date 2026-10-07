# pi SDK 在 Bun 下的能力验证

M0 技术验证（issue #2）的结论。spec（#1）依赖的 pi SDK 能力都已在 Bun 下逐项验证，每一项都有对应的测试，放在 `test/pi-sdk/` 中，随 `bun test` 一起运行。升级 pi 时，这些测试能直接发现 SDK 行为的变化。

验证环境：

- `@earendil-works/pi-coding-agent` 和 `@earendil-works/pi-ai` 都锁定为 `1.0.4`（`package.json` 中写的是精确版本）。`pi-ai` 也直接列为依赖，因为测试和 Runner 要用到它导出的 `fauxProvider`、`InMemoryCredentialStore`、`Type`。
- Bun 1.3.14，Linux x86_64，bubblewrap 0.11.1。
- 安装时 Bun 拦下了 `protobufjs` 的 postinstall 脚本（经 `@google/genai` 引入），不影响下面的任何一项。

## 结论一览

| 验收项                                              | 结论                                                                                                               | 测试                                  |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| `createAgentSession()` 在 Bun 下完成一次会话        | 可行                                                                                                               | `test/pi-sdk/session.test.ts`         |
| faux provider 按脚本驱动含工具调用的会话            | 可行，但要用 `fauxProvider()`，见下文                                                                              | `test/pi-sdk/session.test.ts`         |
| 本项目的 MCP server 通过 SDK 注册，以 `direct` 暴露 | 可行                                                                                                               | `test/pi-sdk/mcp-direct.test.ts`      |
| `spawnHook` 改写 env；bwrap 中读 `/proc`、`sudo`    | 可行，用 `createBashToolDefinition()`；`/proc/$PPID/environ` 可读但只含过滤后的 env；`read` 工具不经过 `spawnHook` | `test/pi-sdk/bash-spawn-hook.test.ts` |
| `SettingsManager.inMemory()` 的签名与任意设置项     | 可行；仓库的 `.pi/settings.json` 不生效                                                                            | `test/pi-sdk/settings.test.ts`        |
| 会话中途切换可用工具集                              | 可行                                                                                                               | `test/pi-sdk/active-tools.test.ts`    |

影响 spec 的结论已在 #1 中评论说明：faux provider 和 bash 工具的 API 名称、`read` 等文件工具能读到进程 env、内存设置不读仓库的 `.pi/settings.json`、仓库的 `.pi/mcp.json` 能覆盖本项目的 MCP server，以及 GitHub runner 上的 bwrap 尚未验证。

## 完全在内存中运行的会话

`test/pi-sdk/harness.ts` 构造的会话不读写 `~/.pi/agent`，Runner 可以照搬这种构造方式：

```ts
const faux = fauxProvider();
const modelRuntime = await ModelRuntime.create({
  credentials: new InMemoryCredentialStore(), // 不读写 auth.json
  modelsPath: null, // 不读 models.json
  refreshOnCreate: false, // 不联网刷新模型目录
});
modelRuntime.registerNativeProvider(faux.provider);

const settingsManager = SettingsManager.inMemory({ ... });
const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, extensionFactories });
await resourceLoader.reload();

const { session } = await createAgentSession({
  cwd, agentDir, model: faux.getModel(), modelRuntime, resourceLoader, settingsManager,
  sessionManager: SessionManager.inMemory(cwd),
});
await session.bindExtensions({}); // 发出 session_start；MCP 扩展在这时连接 server
await session.prompt(promptText);
```

`settings.test.ts` 跑完一次带工具调用的会话后，检查过 `agentDir` 仍然为空。

## 各项细节

### 1. `createAgentSession()` 与 faux provider

- 会话事件包含 spec 计划写入 Execution file 的 `tool_execution_start`、`tool_execution_end`、`agent_settled`。
- **spec 中写的 `registerFauxProvider()` 不能驱动 `createAgentSession()` 的会话。** 它在 `@earendil-works/pi-ai/compat` 中（该模块自称临时的兼容入口，会随 ModelManager 迁移删除），注册到 pi-ai 的全局 API 注册表，而会话的 `ModelRuntime` 不查这个注册表：用它的模型发起 prompt 会报 `No API key found for faux`（`session.test.ts` 中有这一项测试）。应改用 `fauxProvider()`，再调用 `modelRuntime.registerNativeProvider(faux.provider)`。`fauxToolCall()`、`fauxAssistantMessage()` 不变。
- 脚本中的每一步既可以是固定的 `AssistantMessage`，也可以是函数 `(context, options, state, model) => AssistantMessage`。函数能看到这次请求的完整上下文，测试用它检查模型实际收到了什么：
  - 声明给模型的工具不在 `context.tools` 中，而是由上下文中的 system 消息逐条增减（`toolsAdded`、`toolsRemoved`）。用 `getCurrentTools(context.messages)` 得到当前的工具列表。
  - 工具结果是 `role: "toolResult"` 的消息。它后面可能还跟着一条 system 消息，所以要找最后一条 `toolResult`，不能直接取最后一条消息。

### 2. MCP server 以 `direct` 暴露

做法：在一个内联扩展中调用 `pi.registerMcpServer(name, config)`，同时加载 `createMcpExtension()`，然后调用 `session.bindExtensions()`。测试用的是 `src/mcp/github-comment-server.ts`，以 `bun run` 启动。

- 以 `exposure: "direct"` 注册后，工具 `mcp__github_comment__update_comment` 出现在第一次请求声明的工具中，模型可以直接调用，调用结果经 stdio 从 server 返回。
- 第一次 `prompt()` 会等待 `direct` server 连接，默认最多等 10 秒（`createMcpExtension({ startupWaitMs })`）。
- server 名称中的 `-` 在工具名中会变成 `_`。
- **stdio server 继承 action 进程的全部 env**，配置中的 `env` 只是在此基础上追加（pi-mcp 的 `StdioTransport` 默认 `inheritEnv`，`registerMcpServer` 的配置无法关闭）。这与上游的 MCP server 拿到的 env 一致，`GITHUB_TOKEN` 不必写进配置；但也意味着 server 进程中有 provider key。
- `createMcpExtension()` 默认会：

  - 读 `~/.pi/agent/mcp.json` 和受信任项目的 `.pi/mcp.json`，而且**文件中同名的 server 优先于 `registerMcpServer()` 注册的 server**。仓库中的 `.pi/mcp.json` 因此可以覆盖本项目的 server，例如换掉 `github_comment`。实现 M2 时，`loadConfig` 至少要去掉与本项目 server 同名的条目。`loadMcpConfig()` 没有从包的入口导出，要自己读文件，或者从 `dist/extensions/mcp/config.js` 引入。
  - 把 server 日志追加到 `~/.pi/agent/mcp.log`。用 `logPath` 改到 `RUNNER_TEMP` 下或 `/dev/null`。

  测试用 `loadConfig: () => ({ servers: [], errors: [] })` 和 `logPath: "/dev/null"` 屏蔽了这两点。

### 3. bash 的 `spawnHook` 与 bwrap

做法：`createBashToolDefinition(cwd, { spawnHook })` 放进 `createAgentSession()` 的 `customTools`。名为 `bash` 的自定义工具会替换内置的 bash 工具。用 `defineTool()` 包一层，类型才能放进 `customTools` 数组。spec 中写的 `createBashTool()` 接受同样的选项，但返回的是 `AgentTool`，不能直接放进 `customTools`（只接受 `ToolDefinition`）；要用它，只能像 pi 的 `examples/extensions/bash-spawn-hook.ts` 那样在扩展中包一层再 `registerTool()`。

- `spawnHook` 收到 `{ command, cwd, env }`。`env` 是 action 进程的全部 env，加上 pi 注入的 `PI_*` 会话变量（`exposeSessionEnvironment`，默认开启）。返回值中的 `env` 会原样用作子进程的 env，所以白名单过滤可以在这里做。
- 返回的 `command` 仍由 shell 执行（`bash -c`），所以 bwrap 的调用要拼成一条经过转义的 shell 命令。测试用 `shell-quote` 的 `quote()` 拼接：

  ```sh
  bwrap --die-with-parent --new-session --unshare-pid \
    --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp \
    --bind <cwd> <cwd> --chdir <cwd> -- /bin/bash -c <原命令>
  ```

- 只过滤 env、不用 bwrap 时，命令仍能读到 `/proc/<pi 的 pid>/environ`。测试中有这一项对照，用来证明下面 bwrap 的用例确实有意义。
- 用 bwrap 包装后：
  - `$PPID` 是 1，即新 PID namespace 中 bwrap 的 init 进程，它的 env 就是过滤后的 env。所以 `/proc/$PPID/environ` 仍可读取，验收项字面上的"读取会失败"不成立，但其目的（读不到 pi 进程的 env）已经达到；
  - pi 进程在新的 `/proc` 中不可见，`/proc/[0-9]*/environ` 中只有白名单变量和 bash 自己导出的 `PWD`、`OLDPWD`、`SHLVL`、`_`；
  - `NoNewPrivs` 为 1，`sudo` 会报错退出（`The "no new privileges" flag is set, which prevents sudo from running as root`）。没有安装 `sudo` 的机器上，测试只检查 `NoNewPrivs`。
- `/proc/<pid>/environ` 记录的是进程启动时的 env。action 运行中写进 `process.env` 的值不会出现在里面，但 `action.yml` 中 step 的 `env:` 会。
- **`spawnHook` 只覆盖 bash。** `read`、`grep`、`find`、`ls`、`edit`、`write` 都在 pi 进程内执行，测试确认 `read` 能直接读取 `/proc/self/environ`。`allowed_non_write_users` 场景下，env 白名单加 bwrap 只能防住 bash；文件工具要由工具权限扩展拦截对 `/proc` 等路径的访问，或者在这个场景下不提供文件工具。M3 要把这一点纳入设计。
- 尚未验证：
  - GitHub 托管的 `ubuntu-24.04` runner 上能否运行非特权 bwrap。Ubuntu 24.04 默认限制非特权 user namespace，本机 bwrap 能运行，靠的是系统自带的 AppArmor 配置。这一点要在 M3 的集成测试中确认。
  - 用 tmpfs 遮住敏感路径（例如 `RUNNER_TEMP` 中的 prompt 和 MCP 文件、`~/.pi`）。

### 4. `SettingsManager.inMemory()`

- 签名：`SettingsManager.inMemory(settings?: Partial<Settings>, options?: { projectTrusted?: boolean }): SettingsManager`，两个参数都可省略。
- `Settings` 类型没有从包的入口导出，可以用 `NonNullable<Parameters<typeof SettingsManager.inMemory>[0]>` 得到。
- **可以接收任意设置项**：传入的对象经 `structuredClone` 后以 JSON 存储，`Settings` 类型以外的键在运行时原样保留，扩展通过 `pi.getSettings()` 能读到。只是在 TypeScript 中，对象字面量带未知键时要做类型断言。
- 设置只放在内存中。setter 加 `flush()` 不会写盘，会话结束后 `agentDir` 为空。
- **`applyOverrides()` 的值会在 `reload()` 后丢失**；传给 `inMemory()` 的值和 setter 写入的值不会丢。所以 settings 模块应把所有设置一次性传给 `inMemory()`。
- **内存中的 `SettingsManager` 没有项目层**：cwd 中的 `.pi/settings.json` 不会被读取（`getProjectSettings()` 返回 `{}`）。这与 spec 用户故事 39"默认加载仓库提交的 `.pi/` 配置"在设置这部分上冲突。可选做法：

  - 用 `SettingsManager.fromStorage()` 配一个自定义的 `SettingsStorage`：全局层在内存中，项目层在启动时从仓库读入一次，写入只进内存。这样既读到仓库设置，又不写盘。
  - 或者明确不支持仓库的 `.pi/settings.json`，作为偏离登记。

  这一点留给 M1 的 settings 模块决定。

### 5. 会话中途切换工具集

在扩展中处理 `agent_before_settle`：结果未提交时，调用 `pi.setActiveTools(["submit_result"])`，并返回 `{ continue: true, entries: [{ type: "custom_message", ... }] }`。

- 下一次请求只声明 `submit_result`。从模型看，提醒是一条 user 消息，后面跟着一条 `toolsRemoved` 的 system 消息。
- 模型调用已移出可用工具集的工具（例如 `bash`），会得到错误结果 `Tool bash not found`，工具不会执行。
- `submit_result` 的参数可以直接用用户的 JSON Schema：`Type.Unsafe(jsonSchema)`。参数不符合 schema 时，模型收到的错误类似：

  ```text
  Validation failed for tool "submit_result":
    - verdict: must be equal to one of the allowed values

  Received arguments:
  { "verdict": "maybe" }
  ```

- 每次继续之后，`agent_before_settle` 会再次触发，所以"最多提醒 2 次"可以用一个计数器实现。测试确认：两次提醒都未得到回应时，会话共请求 3 次后结束。
- `setActiveTools()` 的改动在本次运行结束后仍然保留，当前会话的工具集不会自动恢复。

## 本次未验证的部分

以下内容不在 #2 的验收范围内，留给后续里程碑：

- `DefaultResourceLoader` 在 SDK 中如何处理项目信任，即仓库的 `.pi/extensions`、skills、`AGENTS.md` 默认是否加载（M2，配合 restore-config）。
- usage 和 cost 字段在 `message_end` 中的确切形状（M1，Execution file）。faux provider 会填充 `usage`，但真实 provider 的 cost 计算没有验证。
- `enableInstallTelemetry` 默认为 `true`，它在 SDK 模式下会发出哪些请求，与 egress 白名单的关系（M1）。
