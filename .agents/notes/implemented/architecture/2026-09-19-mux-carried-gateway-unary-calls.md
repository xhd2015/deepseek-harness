# Agent Note: Mux-carried Gateway unary calls

Status: implemented

English | [中文](2026-09-19-mux-carried-gateway-unary-calls.zh.md)

## Problem

Each browser page keeps an authenticated `/api/remote.mux` WebSocket for Remote streams and events. Gateway unary calls still used a separate HTTP POST through `ctx.connection.rpc`. Chromium can leave that POST pending after several same-origin pages retain their WebSockets, so a page receives `$events` readiness but cannot fetch its Session baseline.

## Decision

Gateway Client unary Remote calls use the existing authenticated mux connection. `RemoteStreamMuxClient.call()` opens the reserved `$invoke` logical stream with the target endpoint and its normal `{ args }` payload. Gateway validates the wrapper, admits only a currently claimed endpoint, dispatches through the existing unary Gateway path, yields one `ConnectionRpcResult`, and ends the logical stream.

The Client requires exactly one item followed by `end`. An absent result, a second item, malformed result data, carrier failure, or cancellation fails the call. Cancellation uses the existing logical-stream cancel frame. A sent unary call is never replayed after a mux loss; the domain's normal reconnect baseline mechanism owns safe retries.

Browser `$events/result` replies use the same unary mux operation. In-process transports keep their existing `connection.rpc.call()` path, and Connection's HTTP RPC bridge remains available to non-Gateway consumers.

## Alternatives considered

**Keep unary calls on HTTP and raise connection limits.** The server admitted independent WebSockets and continued answering raw mux operations. Closing one page immediately released the sixth page's pending Session-list POST, so server limits would not remove the browser-origin resource dependency.

**Open another physical WebSocket for unary calls.** A second per-page socket would repeat the origin connection pressure and duplicate authentication, lifecycle, cancellation, and write ownership already provided by the mux.

**Treat every direct unary endpoint as a stream endpoint.** A reserved `$invoke` wrapper preserves the existing distinction: opening a generated unary endpoint as a normal stream remains invalid, while the internal one-result operation has an explicit payload contract.

**Retry a mux call on a replacement connection.** The Host may have completed a mutation before its response is lost. Retrying generically could duplicate a user action, so Connection reset and domain-level baselines remain the retry point.

## Consequences

Gateway owns one additional internal mux endpoint and carries browser unary results on the same physical connection as Remote streams. The Session Controller remains transport-agnostic and continues to call generated `ctx.remote` methods. A real WebSocket host test and browser-client mux test pin the wrapper, one-result rule, cancellation ownership, and the absence of browser HTTP RPC for Gateway unary calls.
