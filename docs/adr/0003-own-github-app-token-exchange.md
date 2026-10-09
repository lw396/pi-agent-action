# 没传 `github_token` 时，用本项目自己的 GitHub App 和 token 换取服务

用户没传 `github_token` 时，上游用 workflow 的 OIDC token 向 Anthropic 的换取服务（`api.anthropic.com/api/github/github-app-token-exchange`）换一个 Claude GitHub App 的 installation token，评论和提交以 Claude bot 的身份发出。本项目照搬这套机制，但换成自己的一个公开 GitHub App，加上自己运行的换取服务：服务部署在 Cloudflare Workers 上，代码放在本仓库的 `services/token-exchange/` 下。App 的私钥只放在服务里，action 中没有任何凭据。

服务的接口与上游的换取服务保持一致：`POST`，`Authorization: Bearer <OIDC token>`，可选的 JSON 请求体 `{"permissions": {...}}`，成功时返回 `{"token": "..."}`，失败时返回 `{"error": {"message": "...", "details": {"error_code": "..."}}}`。这样 `src/github/token.ts` 只需要换端点地址和 OIDC audience，与上游的其余差异保持为零，上游对这个文件的修复仍然可以 cherry-pick。

服务签发 token 之前要依次确认：

1. OIDC token 由 GitHub Actions 签发（`iss` 为 `https://token.actions.githubusercontent.com`，用其 JWKS 验签），`aud` 是本项目的 audience，没有过期。
2. token 中的仓库装了本项目的 App。
3. 发起请求的 workflow 文件（`workflow_ref` 中的路径）在仓库默认分支上存在，且内容与本次运行使用的版本（`workflow_sha`）相同。job 用的是同一仓库中的 reusable workflow 时（`job_workflow_ref`），它在 `job_workflow_sha` 的版本也要与默认分支上的相同；其他仓库中的 reusable workflow 由调用方的文件固定版本，不单独校验。否则返回错误码 `workflow_not_found_on_default_branch`，action 跳过本次运行，与上游一致。这一条防止有人在分支或 PR 中修改 workflow，拿 App token 去做 workflow 原本不做的事。
4. 请求的权限不超过 App 拥有的权限。默认权限与上游相同（`contents`、`pull_requests`、`issues` 写），`additional_permissions` 可以在此基础上追加。

签发的 token 只对 OIDC token 中的那一个仓库有效。吊销沿用 `action.yml` 中现有的 `always()` 步骤（`DELETE /installation/token`），服务不参与。

不设过渡期：action 直接改用本项目的服务，不再请求 Anthropic 的换取服务。

## Considered Options

- **没传 `github_token` 时直接报错**：最简单，不用运行任何服务；但用户要自己建 App，或者用 `GITHUB_TOKEN`（它推送的 commit 和创建的 PR 不会触发其他 workflow，CI 不会自动运行）。与上游"装上 App 就能用"的体验差距太大。
- **`github_token` 默认用 `${{ github.token }}`**：不传也能运行，但有上面同样的问题，而且用户不容易意识到。
- **继续使用 Anthropic 的换取服务**：本项目不是官方产品，不能借用 Anthropic 的服务和 Claude 的 bot 身份。
- **服务代码放在独立仓库**：部署配置与 action 分开，但服务的接口和 action 的调用方要一起演进；放在同一个仓库中，一个 PR 就能同时修改两边并一起测试。

## Consequences

- 本项目要运行一个安全敏感的线上服务。私钥泄露，所有装了 App 的仓库都会暴露；校验逻辑有错，可能为别人的仓库签发 token；服务不可用时，没传 `github_token` 的 workflow 全部失败。用户随时可以传 `github_token` 绕开服务。
- 服务上线前，没传 `github_token` 的 workflow 会失败。
- `bot_name` / `bot_id` 的默认值取决于 App 注册后的名称和 ID。
- egress 白名单要加上服务的域名。
- 服务的单元测试要加进 CI；部署凭据（Cloudflare API token、App 私钥）不进仓库。
