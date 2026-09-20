# Agent Note: Web runner launch and durable composer drafts

Status: implemented

English | [中文](2026-09-20-web-runner-composer-drafts.zh.md)

## Problem

Worktree tools need to launch an existing DSH Web session with a task, including a review-before-send mode and prompts too large for command-line arguments. A browser-local draft cannot receive text from another process or survive a change of browser origin. Recording an unsubmitted task as a user message would incorrectly make it transcript content and could start model work.

## Decision

The supported launcher remains `dsh web open [dir]`. `-p` and `--prompt` supply inline text; `--prompt-file FILE` reads UTF-8 text without expanding the file back into an argument. Inline and file inputs are mutually exclusive, relative file paths use the caller's working directory, and invalid input fails before Session creation. Prompt text does not enter the session URL. The host build emits the `./open` subpath as its own bundle beside `index` and `startup`, so an installed `dsh` resolves the launcher row. The existing [Web-open decision](2026-09-16-web-open-from-cli.md) retains ownership of server discovery, authentication, and browser selection.

After creating the Session, the launcher submits through the ordinary Host prompt API unless `--no-submit` selects `session/setDraft`. Browser opening follows the acknowledged operation and is independent of submission. A browser-open failure warns without undoing the created Session; an input-operation failure identifies the already-created Session. The browser never auto-submits a loaded draft.

Session Controller owns cold-readable, text-only `session/getDraft` and `session/setDraft` operations. The `session_composer_drafts` storage domain has versioned per-Session records outside the transcript. Empty text removes a record. Both operations validate Session existence without activating its Agent or computing projections. Storage-domain writes provide durable acknowledgement and disposal drains pending writes. Session forks do not copy composer state.

The browser keeps a local text mirror with a persisted `draftDirty` flag for immediate recovery, then reads the Host draft. Unsaved local text, including an empty clear, or an edit during the read takes precedence. Otherwise the editor adopts Host text even when the acknowledged local mirror is nonempty, so a clean mirror cannot restore a task cleared elsewhere. An unsaved empty value prevents a failed Host clear from restoring a stale seed after reload. Host acknowledgement clears the flag only when the local text still matches; older browser records without the flag count as unsaved until synchronized. One observer serializes writes and coalesces intervening edits, including normal submission clearing and failure restoration. Disposal detaches observation and disposes the input shell immediately before awaiting accepted writes. The Host uses last-write-wins replacement; this is durable recovery, not collaborative editing or cross-tab live synchronization.

The `dsh-web` integration is a browser handoff in agent-pro, not a PTY provider or streaming agent result. It invokes the supported DSH launcher and preserves file-backed prompts. wrk chooses browser-specific arguments and leaves Session identity to DSH rather than supplying terminal color or an agent-run-local Session id. Completion means that launch succeeded, not that the model completed the task.

## Alternatives considered

**Store drafts as Session events.** Unsubmitted text is editable interaction state, not model history. Replaying it as a user message would misrepresent user admission; a UI-only event would also make every keystroke part of the transcript lifecycle.

**Carry prompts in browser URLs or localStorage alone.** URL transport exposes task text in browser history and imposes URL-size limits. Browser-local storage cannot receive a Host-side launch request and remains partitioned by origin.

**Register dsh-web as a terminal runner.** PTY providers own readiness, terminal injection, and attached-process behavior. Claiming those capabilities only to pass validation would attach unrelated lifecycle and identity rules to a one-shot browser launch.

**Add revision conflicts or live draft broadcasting.** The current consumer needs initial handoff and reload recovery, not concurrent editing. Serialized Client writes prevent local response reordering; revisions and broadcasting require a separate multi-writer product decision.

## Consequences

Drafts survive Host and browser reloads without creating model-visible messages. The [Host-backed preference decision](../bug-fix/2026-08-06-host-backed-web-preferences.md) still governs user configuration; session-associated draft records are not settings. The [composer isolation proposal](../../proposed/architecture/2026-09-14-composer-model-and-draft-editor.md) remains independent: durable text does not preserve structured references, attachments, caret state, Undo history, or multiple editable roots.

Unsaved browser recovery text, including an empty clear, can replace a newer Host value because local unsaved work takes priority; an acknowledged mirror instead follows the Host on its next mount. Different tabs can overwrite each other's saved text; there is no merge or live conflict UI. Closing a browser does not guarantee completion of in-flight network writes, so the local mirror remains necessary. A launcher requires a running DSH Web instance and does not start a replacement server.

## Verification

Focused Host tests cover cold reads, exact long Unicode text, replacement and clearing, durable reload, missing Sessions, storage failures, and plugin disposal/reopening without an Agent. CLI tests cover prompt parsing, file input, Host admission versus draft writes, and browser failure reporting. Browser persistence tests cover pending reads, edit precedence, write coalescing, failures, and teardown. Assembled GUI and keyless snapshot validation remain separate integration evidence; these focused checks do not establish that the complete GUI suite passes.
