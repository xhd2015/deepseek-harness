---
kind: upgrade-guide
description: "Repeated Web --host flags now add same-port listeners instead of keeping only the last address."
---

# Repeated Web bind addresses

English | [中文](guide.zh.md)

## Change

Previously, repeating `--host` in a Web command kept only its last value. Each occurrence now adds a listener to the same DSH runtime, sharing one port, routing state, and authentication service. A missing or occupied address fails startup and rolls back the whole listener group. Commands that specify no host or one host keep their existing exposure.

## Migration

1. Check launch scripts that append `--host` to a command already containing it. Remove superseded occurrences to preserve the previous single-address exposure; keep several only when each listener is intentional.
2. To enable both loopback families, use `dsh web --host 127.0.0.1 --host ::1 --port 3080`. Each address must be assigned locally; wildcards remain unsupported. Port 0 selects one common port.
3. Custom WebServer configurations can retain `host: 127.0.0.1`, or replace it with `hosts: [127.0.0.1, '::1']`. Do not supply both keys.
4. Confirm all intended addresses appear in the listener diagnostics and serve the same port. Keep browser authorities in `--trusted-host` and Settings grants in `--trusted-host-for-settings`; adding a listener does not add public hostnames or grant Settings access automatically.
