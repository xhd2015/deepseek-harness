# Agent Note: Open a Web session from the CLI

Status: implemented

English | [中文](2026-09-16-web-open-from-cli.zh.md)

## Problem

Operators already keep `dsh web` running, then want a single command from a project directory that creates a new Session for that directory and focuses it in the GUI. The Web New Session flow requires a directory picker in the browser. Headless creates a Session in a different process that the live GUI does not adopt. The token-exchange redirect dropped every query parameter, so a URL could not name a Session.

## Decision

`dsh web open [dir]` is a second invocation of the web profile. It does not bind a server. The serving process writes `$DSH_HOME/web-listen.json` (pid, origin, mode `0600`) after Connection is ready and removes it on dispose; the record carries the process launch token while browser authentication is on and omits it under `--no-auth`, which authorizes every loopback request already. The open client POSTs `workspace/create` then `session/create` with `Authorization: Bearer <token>` when the record holds a token and with no credential header otherwise, then applies any [initial prompt or durable draft](2026-09-20-web-runner-composer-drafts.md) and opens `/?token=…&session=…` (no `token` parameter without one) unless `--no-open`.

`--browser brave|chrome|firefox|edge|safari` is a web-app flag on serve and on `open`. It is passed to the maintained `open` package (`apps.*`, Safari as `Safari`). Omitting it keeps the OS default. Unknown names are usage errors.

Token exchange redirects to `/?session=<id>` when that query is a single safe Session id. The workspace client opens that Session once it appears in the Host list, keeps `?session=` in sync with the selected Session so a copied URL restores it, and shows a localized overlay when the id is missing or malformed. API authentication accepts the same process launch token as Bearer in addition to the browser cookie.

`dsh web open` binds no port and serves no page, no `/api`, and no plugin bundle, so the bundle patch keeps every browser-serving row unmounted through `process.env.DSH_WEB_OPEN === '1'`: `webserver`, `web-runtime`, `modules`, `connection`, and the rows that only feed them (`client-hmr`, `session-log-download`, `open-in-app`, `directory-picker`, `session-controller`, `file-upload`, `ui-deliverables`). Unmounting them is also what keeps the activation audit quiet: a row left enabled waits forever for `webServer`, `webRuntime`, or `connection`, and the audit reports every inactive row.

## Alternatives considered

**Start a second Web server.** Port 3080 is already taken; a second GUI would not share the live Client.

**Create the Session from headless and share JSONL.** The Workspace registry is in-process; the running GUI would not see the Session until restart.

**Watch a drop file instead of HTTP.** The Host already exposes create RPCs; Bearer on `/api` reuses that path and the existing trust fence.

**Persist `--browser` in settings.yaml.** A flag matches `--no-open` and does not change other machines sharing a home.

## Consequences

When browser authentication is on, `web-listen.json` holds a capability equivalent to the printed URL token; its mode is `0600` and it is unlinked when the serving process exits. A `--no-auth` server records origin and pid only, and the client then needs no credential. A crash can leave a stale file, which `open` ignores when the pid is dead. `dsh web open` still boots the rest of the web profile (agent-loop included) even though HTTP is disabled, so it is heavier than a tiny HTTP client.
