# Agent Note: Reveal the open Session's project in the sidebar

Status: implemented

English | [中文](2026-09-18-sidebar-reveal-open-session-project.zh.md)

## Problem

The sidebar groups Sessions under their Workspace, and a folded Workspace renders no Session rows. Restoring `?session=…` or calling `uiWorkspace.openSession(id)` selects a Session, but the Workspace owning it stayed folded whenever the reader had folded it before: the browser opened the current Session's group only while no expansion record existed for that Workspace. The reader then saw an unchanged folded list and had to open Workspaces one by one to find the highlighted Session. Folding the current Workspace was also indistinguishable from folding any other, because the folder tint applied only while the group was expanded.

## Decision

Selecting a Session reopens the Workspace that owns it. `WorkspaceBrowser` observes `list.current` and expands its group once per Session change, overriding a stored closed record; the handled Session id sits in a `useRef`, so folding that same group afterwards survives the next render, and no other Workspace is touched. The rule applies in the grouped view with the Workspace stream ready, no active search query, and no global panel — the same reading of "a Session is being viewed" the Session rows use. The rule is inert in the flat list and while the sidebar is a rail.

A folded Workspace holding the open Session keeps two marks: the business-color folder glyph, now driven by membership alone, and a 2px business-color leading bar (`.projectRowCurrent` in `Rows.module.css`). The project row also carries `aria-current="true"`. Both marks report the reader's own location, not child state: a folded group still shows no pending-interaction or activity indicator for its Sessions.

## Alternatives considered

**Keep the effect in `SessionTree` and drop the explicit-record guard.** `SessionTree` unmounts while a search is active and in the flat view, so the tracked Session would be forgotten and the next mount would reopen a group the reader had deliberately folded. `WorkspaceBrowser` outlives those switches.

**Expand on every render while the current group is folded.** The reader could never fold the open Workspace; it would reopen on the following render.

**Force-expand without tracking the Session change.** Equivalent to the previous alternative: `setGroupExpanded(key, true)` re-arms from the folded record.

**Reveal the open Session's row beyond the five-Session fold.** Opening a Workspace would render long projects in full on every Session open. The fold stays a user gesture, as it is for ordinary browsing.

**Tint only the folder glyph.** A 16px glyph is easy to miss while scanning a long Workspace list; the leading bar survives that scan and reuses the drop-marker accent idiom.

**Also mark the expanded Workspace that holds the open Session.** The highlighted Session row already carries that state, so a second mark on its header is noise.

## Consequences

The reveal writes an ordinary `groupExpansion` record in `dsh.workspace.view.v5`, so it persists like any other expansion: a reload of a `?session=…` URL reopens the folded Workspace again. That is the intended counterweight to the folded-row marker — the marker exists for the reader who folds the current Workspace during a visit, not to keep it folded across a fresh load. The rule supersedes the membership-only expansion rule recorded in [Workspace sidebar order and folding](../../archived/feature/2026-08-11-workspace-sidebar-order-and-folding.md).

Nothing model-visible, durable, or on the wire changes: the change is client presentation plus one viewing-store write. `packages/client/ui-workspace/tests/workspace-browser.client.spec.tsx` pins the reopen, the preserved fold, and the marker; `rows.client.spec.tsx` pins the row states; `browser-styles.client.spec.ts` pins the accent declaration against the CSS source.
