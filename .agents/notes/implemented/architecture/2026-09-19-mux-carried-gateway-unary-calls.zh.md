# Agent Note: Mux-carried Gateway unary calls

Status: implemented

[English](2026-09-19-mux-carried-gateway-unary-calls.md) | 中文

## Problem

每个浏览器页面都会为 Remote 流和事件保持一条经过认证的 `/api/remote.mux` WebSocket。Gateway 的一元调用仍通过 `ctx.connection.rpc` 使用独立的 HTTP POST。多个同源页面保留 WebSocket 后，Chromium 可能让该 POST 一直 pending；页面已收到 `$events` ready，却无法取得 Session baseline。

## Decision

Gateway Client 的一元 Remote 调用使用既有的已认证 mux 连接。`RemoteStreamMuxClient.call()` 打开保留的 `$invoke` logical stream，并携带目标 endpoint 和正常的 `{ args }` payload。Gateway 校验 wrapper，只接受当前已认领的 endpoint，通过既有 Gateway 一元调用路径分发，产出一个 `ConnectionRpcResult`，然后结束 logical stream。

Client 要求恰好一个 item，随后是 `end`。缺少结果、第二个 item、畸形结果数据、carrier 故障或取消都会使调用失败。取消使用既有的 logical-stream cancel frame。mux 丢失后，已发出的一元调用绝不重放；领域既有的重连 baseline 机制负责安全的重试。

浏览器的 `$events/result` 回复也使用同一个一元 mux 操作。进程内 transport 保留既有的 `connection.rpc.call()` 路径，Connection 的 HTTP RPC bridge 仍供非-Gateway consumer 使用。

## Alternatives considered

**保留 HTTP 一元调用并提高连接限制。** Server 接受了独立 WebSocket，并持续回答原始 mux 操作。关闭一个页面会立刻释放第六个页面 pending 的 Session-list POST，因此提高 Server 限制不能消除浏览器同源资源依赖。

**为一元调用再开一条物理 WebSocket。** 第二条每页 socket 会重复同源连接压力，并重复已有 mux 提供的认证、生命周期、取消和写入所有权。

**把每个直接一元 endpoint 都当作流 endpoint。** 保留的 `$invoke` wrapper 保持现有区分：把生成的一元 endpoint 当普通流打开仍然无效，而内部的一结果操作拥有明确的 payload contract。

**在替换连接上重试 mux 调用。** Host 可能在响应丢失前已经完成 mutation。通用重试可能重复用户操作，因此 Connection reset 与领域 baseline 仍是重试位置。

## Consequences

Gateway 拥有一个额外的内部 mux endpoint，并在与 Remote 流相同的物理连接上承载浏览器一元结果。Session Controller 保持 transport 无关，并继续调用生成的 `ctx.remote` 方法。真实 WebSocket Host 测试与浏览器 Client mux 测试固定 wrapper、单结果规则、取消所有权，以及 Gateway 一元调用不再使用浏览器 HTTP RPC。
