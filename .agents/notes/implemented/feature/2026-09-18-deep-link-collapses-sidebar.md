# Agent Note: Collapse the sidebar on a Session deep link

Status: implemented

English | [中文](2026-09-18-deep-link-collapses-sidebar.zh.md)

## Problem

`dsh web open` and any copied `?session=` URL open the GUI on one Session, but the frame always painted the 280px sidebar first. A reader who follows a deep link into a new tab wants the Conversation, and the Session list is redundant for a document that already names its Session.

Deciding this from the Host list is too late to be invisible: `bindSessionUrl` can only settle the link once the Session list arrives, which is a few hundred milliseconds after the frame's first paint. The measured result was a frame that painted the sidebar and then animated it away — the reader watches the layout flinch. `SidebarRoot` already renders a cold rail statically (its `everWide` ref only crossfades a *live* collapse), so the fix had to move the decision earlier rather than make the later one prettier.

## Decision

`ui-workspace` parses `?session=` while its entry activates and, for a well-formed id, calls `ctx.layout.collapseSidebar()` immediately. Client entries activate before the renderer mounts the frame, so the store is already collapsed when the frame first renders; the rail is the first geometry painted and nothing animates. `collapseSidebar` is idempotent: on a wide frame it zeroes the width preference, on a narrow frame it drops the expansion override, matching `toggleSidebar`'s two branches without its flip.

Whether the id is listed does not affect the sidebar. The deep link still settles against the Host list afterwards, opening a listed Session and raising the unusable-link overlay otherwise — over that rail. A malformed or absent query leaves the default frame, which is decidable synchronously from the URL alone. In-app navigation (a row click, a search result, New Session, a fork) runs after activation and never collapses. Layout state stays per-document (`createLayoutStore` declares no persistence), so the collapse cannot leak into another page or tab, and the reader's next toggle is the last word for that document.

An earlier revision of this note gated the collapse on the id resolving, so only a *listed* Session's document collapsed. That rule could only run after the list arrived, and the reader saw the panel it was about to remove; the alternatives below record why the other repairs lost. The rule covers any fresh document, including a reload of a URL that already carries `?session=`, which the client keeps in sync with the current selection.

## Alternatives considered

**Collapse in the deep link's found branch, after the list settles (the earlier decision).** It keeps "not found" byte-for-byte as before, but it is structurally after the first paint: the browser scenario recorded the frame at 280px and then at 56px for the same document. Paying a visible flinch to preserve the frame state of a broken link is the wrong trade.

**Found branch plus a rollback expand for an unusable link.** Same pre-paint problem in the error case — collapsed, then expanded once the list settles — so it buys nothing but a second directional layout action.

**Hold the frame's first paint until the deep link settles.** No flinch and no guessing, but the mount would wait on the Host list, which is not guaranteed to arrive (a reconnecting or failed connection). A hard gate can leave the app on its boot page indefinitely, and a timeout falls back to flinching, so the complexity does not buy determinism.

**Let the Host mark the served document.** The webserver has an index injection seam, so a Host row could mark "this `?session=` id is listed" and the client could collapse pre-paint with the correct answer. The seam currently receives no request URL, so this needs the webserver to thread the request through to every injection listener, a Host plugin reading the Session registry, and a new served-document hint — a server-client contract for a purely cosmetic decision that the URL alone can already make.

**Reuse `ctx.layout.toggleSidebar()`.** It flips whichever branch applies: a wide frame already closed (0) would *expand*, and a narrow frame would set the manual expansion override instead of clearing it. The sidebar shell clamps it to expand-only for the same reason, from the state it owns.

**Snap instead of animating the after-paint collapse.** Treats the symptom: the frame still paints a sidebar it is about to remove, and an instant variant needs its own flag mirroring `rightbarInstant`.

## Consequences

The rail is the first geometry a deep-linked document paints. `apps/web/tests/deep-link-sidebar-collapse.e2e.ts` records every distinct column track the frame renders from document start — the listed-id and unlisted-id cases must never include `280px` — and that assertion fails against the after-paint implementation, so the visual regression is pinned rather than described.

A well-formed but unlisted `?session=` now lands on a collapsed frame with the unusable-link notice, where it previously landed on an expanded one. The notice names the problem and one toggle restores the sidebar, so the broken-link path trades a frame width for the absence of motion everywhere else.

Nothing durable or model-visible changes: the write stays inside the transient layout store, and no session event, wire payload, or persisted preference is touched. `packages/client/ui-workspace/tests/apply.client.spec.ts` pins which URLs request the collapse, and `packages/client/ui-layout/tests/layout-store.client.spec.ts` with `app-frame.client.spec.tsx` pin the action and the resulting rail.
