# bash 子进程的 env 用白名单，不用上游的黑名单

在 `allowed_non_write_users` 场景下，模型执行的 bash 命令只能拿到白名单中的环境变量（`PATH`、`HOME`、`LANG`、`CI`、非敏感的 `GITHUB_*` 等），用户脚本需要的其他变量通过输入显式放行。上游（Claude Code）用的是内置的一百多项黑名单，但这份清单在 Claude Code 二进制内部，我们拿不到；自己维护一份同等的黑名单，又会漏掉 pi 新增的 provider，以及用户自定义的 secret（例如 `MY_DB_PASSWORD`）。

## Consequences

- 依赖非标准环境变量的用户脚本会拿不到这些变量，必须显式放行。这一项要写进迁移表。
- env 过滤要配合 bwrap 的 PID 隔离才真正有效。bwrap 不可用时，`cat /proc/$PPID/environ` 仍然能读到 pi 进程的 env；这种情况下的处理与上游一致，只做尽力而为的过滤，并在 `docs/security.md` 中写明。
- 按值脱敏复用同一份白名单：白名单以外、长度不少于 16 的值都视为密钥。
- `GH_TOKEN` 不在白名单中，bash 中的 `git push` 和 `gh` 拿不到 token；需要时由用户在 `allowed_bash_env` 中放行，代价是 agent 也能拿到它。
- 文件工具在 pi 进程内执行，不受 env 过滤和 bwrap 约束；隔离时由工具权限扩展拒绝 `/proc` 下的路径。
