# ACP run modes (`omp.goalMode` / `omp.vibeMode` v1)

Extension of the [Agent Client Protocol](https://agentclientprotocol.com)
implemented by `omp acp` so clients can run goal mode, guided goals, and vibe
mode, which otherwise exist only in the interactive TUI. Version: `1`.
Plan mode and its review are specified in [ACP Plan Review](acp-plan-review.md).

## Modes

The session `mode` (both `modes` / `session/set_mode` and the `mode` config
option) carries these ids:

| id        | when offered                                  |
| --------- | --------------------------------------------- |
| `default` | always                                        |
| `plan`    | `plan.enabled`                                |
| `goal`    | `goal.enabled`                                |
| `vibe`    | top-level sessions (the vibe tools are loaded) |

Plan, goal, and vibe share one mode slot, as in the session journal. The
current mode is `plan` while plan mode is on, `vibe` while vibe mode is on,
and `goal` while the session holds a goal (active, paused, or budget-limited)
or goal mode is armed; otherwise `default`.

Switching from one mode to another exits the current mode first:

- **Entering `goal`** with no goal arms it (`armed: "objective"`): the next
  prompt that is not a slash command becomes the objective and runs as the
  goal's first turn. Re-selecting `goal` while a goal is paused resumes it.
- **Leaving `goal`** drops the goal (accumulated usage stays in the session
  log) or cancels the armed entry. Clients should confirm with the operator
  before leaving goal mode while a goal exists.
- **Entering `vibe`** reduces the tool set to `read`, optional `todo`, and the
  `vibe_*` worker tools and injects the director instructions.
- **Leaving `vibe`** aborts the director turn, kills every worker in the
  session's scope, and restores the previous tool set.

## Session state snapshot

`session/new`, `session/load`, `session/resume`, `unstable_session/fork`, and
`session/set_mode` responses carry, next to `omp.planMode` / `omp.planReview`:

```jsonc
{
  "_meta": {
    "omp.goalMode": {
      "version": 1,
      "active": true, // the session is in goal mode (a goal exists or goal mode is armed)
      "armed": null, // "objective" | "interview" | null
      "goal": {
        // null when no goal exists
        "id": "…",
        "objective": "…",
        "status": "active", // active | paused | budget-limited | complete | dropped
        "tokenBudget": 50000, // omitted without a budget
        "tokensUsed": 1234,
        "timeUsedSeconds": 42,
        "createdAt": 1760000000000,
        "updatedAt": 1760000000000
      }
    },
    "omp.vibeMode": { "version": 1, "active": false }
  }
}
```

A loaded or resumed session that was running a goal reports it `paused`: a
goal never restarts on its own after a reload.

## `goal_update` session update

Sent whenever the goal snapshot changes (creation, accounting, pause, resume,
budget, completion, drop) or the armed state changes, with the same body as
`omp.goalMode` minus `version` / `active`:

```jsonc
{ "sessionUpdate": "goal_update", "goal": { … } | null, "armed": null }
```

`goal: null, armed: null` means goal mode ended. When the mode id changes as a
result (a completed goal returns to `default`), `current_mode_update` and
`config_option_update` follow.

## Goal continuation

With `goal.continuationModes` containing `"acp"` (the default), an active goal
keeps working inside the `session/prompt` that owns the turn: after each yield
the agent submits a hidden continuation turn, and the prompt response settles
only when the goal completes, pauses, hits its budget, has only blocked todo
items left, or a continuation turn makes no new progress. Every goal turn
streams as part of that prompt. Goal turns never start outside a client
prompt; selecting `goal` to resume a paused goal waits for the next prompt.

`session/cancel` pauses the goal and stops continuation. So does a new
`session/prompt` that arrives while goal turns are still owed to the current
prompt, even between turns: it interrupts the goal instead of queueing behind
it. `/goal resume` restarts it.

## Commands

Advertised in `available_commands_update` and handled by the ACP agent:

| command | behavior |
| --- | --- |
| `/goal <objective>`, `/goal set <objective>` | Create the goal (replace an active one) and run the objective as its first turn. Refused while a goal is paused. |
| `/goal`, `/goal show` | Print the objective, status, token usage, and time spent. |
| `/goal pause` / `/goal resume` | Pause; resume a paused goal (or continue an active one) and keep working in this prompt. |
| `/goal drop` | Drop the goal and restore the tool set. |
| `/goal budget <N\|off>` | Set or clear the token budget; a raised budget continues the goal in this prompt. |
| `/guided-goal [rough objective]` | Expose the `goal` tool and start the interview (`armed: "interview"`). The agent asks its questions as ordinary turns and finishes with `goal create`, which enters goal mode and continues. |
| `/vibe [prompt]` | Toggle vibe mode; a prompt is sent as the first directive. |

Goal commands are refused while plan or vibe mode is on, and `/vibe` while
plan or goal mode is on (`Exit … mode first.`).

## Vibe workers

Worker turns run in the background and their results wake the director. While
a director prompt has worker turns running whose results are still owed to it,
the prompt stays open and each finished worker's result runs a director turn
that streams to the client. `session/cancel`, or a new prompt, ends the wait
only: the workers keep running and their results reach the director in a later
prompt.
Closing the session parks the workers; reloading a vibe session rehydrates
them.

## Client checklist

1. Render the `mode` options as delivered; read `omp.goalMode` /
   `omp.vibeMode` on session responses to restore goal and vibe UI.
2. Treat `goal_update` as the live goal state; `goal: null, armed: null` ends it.
3. Confirm with the operator before switching away from `goal` while a goal
   exists: the switch drops it.
4. Keep the prompt busy indicator until the `session/prompt` response arrives;
   a goal or vibe prompt may run many turns.
