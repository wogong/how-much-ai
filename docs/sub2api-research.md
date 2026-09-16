# sub2api 账户额度 API 调研

核查日期：2026-09-16。对象为 [Wei-Shaw/sub2api](https://github.com/Wei-Shaw/sub2api)，源码版本固定为 `881f3202694c6bc932446931a30c27d9675178b9`；实际部署版本可能不同。本次仅核查公开源码，未访问用户实例。

## 结论

管理员可以通过 sub2api HTTP API 读取其已接入的 Claude / OpenAI OAuth 账户额度。因此 How Much AI 可以增加可选的 sub2api 数据来源，省去在本项目再次导入同一账户的上游登录凭据。前提是 sub2api 已持有可用凭据，并且对应账户类型支持额度查询。本项目自动轮询仅读取账户快照；用户手动刷新时调用 `/usage?source=active&force=true`，这可能触发 OpenAI 上游探测。界面区分额度采样时间和主动刷新请求时间；请求成功并不保证采样更新。具体步骤见 [部署说明](SELF_HOSTING.md#sub2api-administrator-accounts)。[账户路由](https://github.com/Wei-Shaw/sub2api/blob/881f3202694c6bc932446931a30c27d9675178b9/backend/internal/server/routes/admin.go#L354)、[额度服务](https://github.com/Wei-Shaw/sub2api/blob/881f3202694c6bc932446931a30c27d9675178b9/backend/internal/service/account_usage_service.go#L348)

## 管理员接口

| 用途 | 请求 |
| --- | --- |
| 列出上游账户 | `GET /api/v1/admin/accounts` |
| 查询单账户额度 | `GET /api/v1/admin/accounts/:id/usage` |
| 查询被动采样 | `GET /api/v1/admin/accounts/:id/usage?source=passive` |
| 批量查询额度 | `POST /api/v1/admin/accounts/usage/batch` |

单账户接口默认 `source=active`，另接受 `force=true`；批量请求使用 `account_ids` 和 `force` 字段，返回按账户分组的 `usage` 与 `errors`。不要把 `force` 理解为所有供应商都保证绕过缓存。[处理器](https://github.com/Wei-Shaw/sub2api/blob/881f3202694c6bc932446931a30c27d9675178b9/backend/internal/handler/admin/account_handler.go#L2518)、[批量处理器](https://github.com/Wei-Shaw/sub2api/blob/881f3202694c6bc932446931a30c27d9675178b9/backend/internal/handler/admin/account_handler.go#L2657)

鉴权为 `x-api-key: <Admin API Key>`，或 `Authorization: Bearer <管理员 JWT>`。普通转发 API Key 不是 Admin API Key；管理员密钥应仅由本项目服务端保管。该中间件授予管理员权限，没有为上述查询提供独立只读权限范围。[鉴权中间件](https://github.com/Wei-Shaw/sub2api/blob/881f3202694c6bc932446931a30c27d9675178b9/backend/internal/server/middleware/admin_auth.go#L23)

## 额度含义与限制

- 返回结构包含 `five_hour`、`seven_day`，以及供应商适用的附加窗口。窗口含 `utilization`（百分数，可超过 100）、`resets_at`、`remaining_seconds`。UI 可按 `max(0, 100 - utilization)` 展示剩余百分比；这不是保证可换算为绝对 token 数的余额。[数据结构](https://github.com/Wei-Shaw/sub2api/blob/881f3202694c6bc932446931a30c27d9675178b9/backend/internal/service/account_usage_service.go#L148)
- Claude OAuth 主动查询需要对应 profile scope，并有缓存；SetupToken 主动分支使用 session window 估算。显式 `source=passive` 仅支持 Anthropic OAuth / SetupToken，读取采样数据，不访问上游。[主动分支](https://github.com/Wei-Shaw/sub2api/blob/881f3202694c6bc932446931a30c27d9675178b9/backend/internal/service/account_usage_service.go#L393)、[被动分支](https://github.com/Wei-Shaw/sub2api/blob/881f3202694c6bc932446931a30c27d9675178b9/backend/internal/service/account_usage_service.go#L588)
- OpenAI OAuth 从已存储的 Codex 快照构建窗口，并按条件主动探测；普通账户探测请求走 Responses，Spark shadow 账户另走额度查询服务。探测失败可以继续返回已有数据，`updated_at` 在该分支被初始化为当前请求时间，不能独自证明上游采样新鲜度。缺少快照时也可能因本地统计补出 `utilization: 0` 的窗口，不能无条件解读为确认剩余 100%。[OpenAI 分支](https://github.com/Wei-Shaw/sub2api/blob/881f3202694c6bc932446931a30c27d9675178b9/backend/internal/service/account_usage_service.go#L711)、[探测实现](https://github.com/Wei-Shaw/sub2api/blob/881f3202694c6bc932446931a30c27d9675178b9/backend/internal/service/account_usage_service.go#L831)
- 套餐名称与额度窗口是不同数据：OpenAI `plan_type` 是账户凭据元数据，导入流程可以从 token 信息补齐，不能假设单独调用 `/usage` 会返回 Plus / Pro 名称。本项目集成时只提取所需展示字段，不向浏览器透传管理员账户原始响应。[元数据补齐](https://github.com/Wei-Shaw/sub2api/blob/881f3202694c6bc932446931a30c27d9675178b9/backend/internal/handler/admin/account_data.go#L720)、[账户 DTO](https://github.com/Wei-Shaw/sub2api/blob/881f3202694c6bc932446931a30c27d9675178b9/backend/internal/handler/dto/types.go#L215)

## 不要混淆的接口

普通登录用户的 `/api/v1/subscriptions`、`/active`、`/progress`、`/summary` 描述 sub2api 自身分配的订阅；`GET /v1/usage` 是转发 API Key 的配额、订阅或钱包余额查询。它们不等同于管理员查看的 Claude / ChatGPT 原厂账户剩余额度。[用户路由](https://github.com/Wei-Shaw/sub2api/blob/881f3202694c6bc932446931a30c27d9675178b9/backend/internal/server/routes/user.go#L129)、[网关 usage 处理器](https://github.com/Wei-Shaw/sub2api/blob/881f3202694c6bc932446931a30c27d9675178b9/backend/internal/handler/gateway_handler.go#L1528)
