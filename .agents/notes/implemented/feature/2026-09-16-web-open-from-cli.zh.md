# Agent Note: 从 CLI 打开 Web Session

Status: implemented

[English](2026-09-16-web-open-from-cli.md) | 中文

## Problem

操作者已经让 `dsh web` 常驻，却希望在项目目录里用一条命令为该目录创建新 Session 并在 GUI 中聚焦。Web 的 New Session 流程需要在浏览器里选目录。Headless 在另一个进程里创建 Session，正在运行的 GUI 不会接管。token 交换的重定向会丢掉全部 query，因此 URL 无法指定 Session。

## Decision

`dsh web open [dir]` 是 web profile 的第二次调用，不绑定服务器。正在服务的进程在 Connection 就绪后写入 `$DSH_HOME/web-listen.json`（pid、origin、launch token，权限 `0600`），dispose 时删除。open 客户端用 `Authorization: Bearer <token>` 依次 POST `workspace/create` 与 `session/create`，处理可选的[初始提示词或持久草稿](2026-09-20-web-runner-composer-drafts.zh.md)，除非 `--no-open`，再打开 `/?token=…&session=…`。

`--browser brave|chrome|firefox|edge|safari` 是 serve 与 `open` 共用的 web 应用 flag，交给维护中的 `open` 包（`apps.*`，Safari 为 `Safari`）。省略则使用操作系统默认浏览器。未知名称是用法错误。

token 交换在 query 中仅有一个安全 Session id 时重定向到 `/?session=<id>`。workspace 客户端在 Host 列表出现该 Session 后打开它，并把 `?session=` 与当前选中 Session 保持同步，以便复制 URL 即可恢复；id 缺失或非法时显示本地化提示。API 认证在浏览器 cookie 之外，还接受同一进程 launch token 作为 Bearer。

当 `webStartup.mode === 'open'` 时，禁用必选 Web 行（`webserver`、`web-runtime`、`modules`、`connection`），避免客户端调用触发必选启动审计或占用第二个端口。

## Alternatives considered

**再启动一个 Web 服务器。** 3080 已被占用；第二个 GUI 不会共享正在运行的 Client。

**用 headless 创建 Session 并共享 JSONL。** Workspace 注册表在进程内；正在运行的 GUI 重启前看不到该 Session。

**监视 drop 文件而不是 HTTP。** Host 已暴露 create RPC；在 `/api` 上使用 Bearer 复用该路径和现有信任围栏。

**把 `--browser` 持久化进 settings.yaml。** flag 与 `--no-open` 一致，也不会改动共用同一 home 的其他机器。

## Consequences

`web-listen.json` 持有与打印 URL 中 token 同等的能力；文件权限为 `0600`，服务进程退出时删除。崩溃可能留下过期文件，`open` 在 pid 已死时忽略它。`dsh web open` 仍会启动 web profile 的其余部分（包括 agent-loop），即使 HTTP 已禁用，因此比纯粹的 HTTP 客户端更重。
