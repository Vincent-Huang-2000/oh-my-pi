# ACP Plan Review (`omp.planReview` v1)

Versioned extension of the [Agent Client Protocol](https://agentclientprotocol.com)
implemented by `omp acp` so rich clients (desktop apps, editors) can run the
full five-option plan review instead of the minimal two-option approval
elicitation. Version: `1`.

## Motivation

Plan mode ends when the agent writes the plan slug to `xd://propose`. The
proposal handler blocks on an ACP elicitation, so clients without form support
would strand the agent; today every client gets a two-option
`Approve and execute` / `Refine plan` select. This extension upgrades that
elicitation to the five review options and adds the side channels a review UI
needs: full plan content, execution-model tiers, context usage, reopening, and
decision submission outside a pending elicitation.

## Capability negotiation

Clients advertise nothing new: form capability (`clientCapabilities.elicitation.form`)
already gates the rich flow. Non-form clients keep the auto-approve
(keep-context) fallback. The agent reports its support through the payloads
below, present on every relevant response.

## Session state snapshot

`session/new`, `session/load`, `session/resume`, `unstable_session/fork`, and
`session/set_mode` responses carry `_meta`:

```jsonc
{
  "_meta": {
    "omp.planMode": {
      "version": 1,
      "active": true, // session is in plan mode
      "planFilePath": "local://<slug>-plan.md", // present when active
      "content": "…" // full plan text, or null when unreadable
    },
    "omp.planReview": {
      "version": 1,
      "active": true, // a pending review exists and can be reopened
      "reviewId": "…", // present when active
      "planFilePath": "local://<slug>-plan.md",
      "title": "…",
      "planExists": true
    }
  }
}
```

When inactive, the payloads are `{ "version": 1, "active": false }`.

## `plan_review_update` session update

Sent when a review opens (before its elicitation), when the client reopens it,
and with `review: null` when it closes. `review` is null only in the close
update.

```jsonc
{
  "sessionUpdate": "plan_review_update",
  "review": {
    "reviewId": "…", // stable for the life of the review
    "planFilePath": "local://<slug>-plan.md",
    "title": "…",
    "planExists": true,
    "content": "…", // full plan text; null when unreadable
    "feedback": "…", // accumulated refine feedback
    "options": [
      { "id": "execute", "label": "Approve and execute", "description": "…" },
      { "id": "compact", "label": "Approve and compact context", "description": "…" },
      { "id": "keep", "label": "Approve and keep context", "description": "…", "disabled": true },
      { "id": "refine", "label": "Refine plan", "description": "…" },
      { "id": "save", "label": "Save and quit", "description": "…" }
    ],
    "executionModels": [ // optional; omitted for singleton cycles
      { "id": "default", "label": "…", "default": true },
      { "id": "slow", "label": "…" }
    ],
    "context": { "tokens": 12345, "contextWindow": 200000 } // optional
  }
}
```

`option.id` values are stable contract strings. `keep` is disabled above 95%
context usage. This limit is also enforced when a form response arrives and
immediately before a queued decision executes. A rejected choice preserves the
plan and pending review; action requests return `{ ok: false, error }` so the
client can choose another strategy. Non-form auto-approval cannot bypass the
limit either. `executionModels[].id` is the session's role-model key
(`default`, `slow`, `smol`, `plan`, custom roles).

## Decision submission

### Through the elicitation

The review elicitation (`mode: "form"`) exposes these properties:

- `decision` (string, `oneOf` the enabled option ids);
- `feedback` (string, optional; sent to the agent on refine);
- `savePath` (string, required when the decision is `save`; workspace-relative
  or absolute path);
- `editedContent` (string, optional; full plan text edited in the review UI);
- `executionModel` (string, optional; `executionModels[].id`).

Dismissal/cancel keeps plan mode active (refine semantics) and never approves.
`save` without a `savePath` is rejected and the review stays pending.

### Through extension methods

When the review was dismissed/refined and no elicitation is pending, clients
drive it over `extMethod`:

- `omp.planReview/reopen` — params `{ sessionId, reviewId? }` (review id
  optional; latest pending review wins). Emits a fresh `plan_review_update`
  and returns `{ ok: true, reviewId }`, or `{ ok: false, error }` when no
  pending review exists or the plan file is gone.
- `omp.planReview/action` — params
  `{ sessionId, reviewId, decision, feedback?, savePath?, editedContent?, executionModel? }`.
  The same shape as the elicitation payload. Returns `{ ok: true }` after the
  decision executes, or `{ ok: false, error }` for an invalid action, an
  unknown/stale `reviewId`, or a missing plan file. The resulting agent turn
  (execution dispatch, refine feedback prompt) streams like a client prompt.

## Semantics

| decision | behavior |
| --- | --- |
| `execute` | Exits plan mode, starts a fresh session (cleared context), copies session-local artifacts, restores the plan file into the new artifact root, then dispatches the plan-approved execution turn (`contextPreserved: false`). |
| `compact` | Exits plan mode, compacts the session with the plan-mode distillation guidance, then dispatches the execution turn (`contextPreserved: true`). |
| `keep` | Exits plan mode and dispatches the execution turn (`contextPreserved: true`). Plain keep (no execution model, no edited content) continues in the current turn without an extra dispatch. |
| `refine` | Keeps plan mode active; feedback is returned to the agent (elicitation path) or dispatched as a prompt (action path). Edited content is written back to the plan file. Feedback persists with the review for reopen. |
| `save` | Writes the plan to `savePath` (resolved against the session cwd), exits plan mode, and starts a fresh session. |
| dismissal / `cancel` | Keeps plan mode active; the review closes without granting write access. |

With `plan.autosave` enabled, execution approvals (`execute`, `compact`, and
`keep`) also save the approved content to the configured autosave directory
before execution. Autosave failure does not cancel approval. `save` writes only
to the explicitly selected path and does not start execution.

Execution strategies that need an idle session run at the end of the current
turn: the proposal turn is aborted silently (mirroring the TUI's plan-approval
abort) and the outcome executes from the `agent_end` handler, so the synthetic
execution turn streams to the client before the prompt response settles.

### Fresh-session identity handoff

After `execute` or `save` creates a new session, the agent sends a
`session_info_update` on the **old** session ID with
`_meta["omp.sessionReplacement"] = { "version": 1, "sessionId": "<new-id>" }`.
Clients must adopt the new ID before processing subsequent execution updates
or issuing requests. The owning prompt response still completes its original
JSON-RPC request. Future prompts, modes, close requests, and tool bridge calls
use the new ID; loading the old ID reopens the saved planning transcript.
The handoff is followed by command and session-info updates for the new ID.

## Persistence and restoration

The pending review is persisted as `.omp-plan-review.json` in the
session-local root next to the plan file:

```json
{
  "version": 1,
  "reviewId": "…",
  "planFilePath": "local://<slug>-plan.md",
  "title": "…",
  "planExists": true,
  "feedback": "…"
}
```

Loading or resuming a session restores plan mode from the mode-change journal,
even before the first proposal or when the plan file has not been created yet.
The proposal handler is reinstalled. Pending reviews additionally require an
existing plan file. Explicit mode exit, approval, save, and cancel all delete
the review state; cancel preserves journaled plan mode without reopening the
consumed review. Disabled plan support clears journaled plan mode as well.
`/plan-review`
in text mode reopens the pending review; the TUI-only command is not
advertised to ACP clients.

## Client checklist

1. Read `_meta["omp.planMode"]` / `_meta["omp.planReview"]` on session
   responses to restore plan-mode UI and pending reviews.
2. Render `plan_review_update` notifications as the review surface; answer the
   paired elicitation with the operator's decision, or use
   `omp.planReview/action` for reopened reviews.
3. Treat `review: null` as "close the review UI".
4. Never infer approval from dismissal: only an explicit `execute`/`compact`/
   `keep`/`save` decision approves.
