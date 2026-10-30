# Agent Note: Proxy provider settings

Status: implemented

English | [中文](2026-09-20-proxy-provider-settings.zh.md)

## Problem

Generated local-proxy routes need a settings namespace consumed by both the adapter and the Models editor. OpenAI-compatible requests require a nonempty client credential even when the proxy owns upstream authentication.

## Decision

The pi-ai adapter registers settings and model discovery under `llm-proxy-providers`. The Models editor reads and writes that namespace. Package names, plugin identity, composition row ids, and the `llm-pi-ai` credential-record scope retain their existing identities. Users migrate settings themselves; the old settings namespace has no alias.

## Alternatives considered

**Rename only generator output.** Rejected because DSH would not consume the resulting settings.

**Rename credential records with settings.** Rejected because changing a configuration section does not require moving stored sign-ins.

**Accept both settings namespaces.** Rejected because two writable locations introduce precedence and migration behavior without a current requirement.

## Consequences

Provider configuration uses the same namespace in settings files, discovery calls, and the Models editor. Existing sign-ins keep their stored identities. Existing settings files require manual migration. Loader-composition and Models-editor tests cover the updated consumers.
