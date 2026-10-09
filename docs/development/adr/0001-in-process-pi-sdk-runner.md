# Runner 在进程内调用 pi SDK

Runner 在 action 进程内通过 `createAgentSession()` 运行 pi，而不是启动 `pi --mode json` 子进程。本项目依赖的几项能力，包括 `tool_call` 权限拦截、输出脱敏、`submit_result` 结构化输出、通过 SDK 注册 MCP server、内存中的 `SettingsManager`，都要在 SDK 中才能方便地实现。改用子进程的话，这些扩展只能以文件形式加载，还要额外解析 JSONL 事件流。

## Considered Options

- **CLI 子进程（`pi --mode json`）**：action 可以为 pi 进程构造一份最小的 env，进程边界更清晰。没有选择它，是因为 bash 的隔离不需要依赖这个进程边界：`spawnHook` 已经能改写 bash 的 env 和 command。

## Consequences

- provider key 和 GitHub token 与 action 处在同一个进程环境中。bash 的隔离必须依靠 `createBashTool()` 的 `spawnHook` 改写 env 和 command（见 ADR-0002），不能指望"给子进程一份干净的 env"。
- pi 是 `package.json` 中的依赖，锁定精确版本；SDK 的 API 变化会直接影响 Runner，所以升级 PR 要跑集成测试。
- 运行时是 Bun，需要先验证 pi SDK 能在 Bun 下运行。
