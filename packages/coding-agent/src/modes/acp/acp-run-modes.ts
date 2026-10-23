/**
 * ACP run modes beyond plan mode (see `docs/acp-run-modes.md`).
 *
 * Goal mode (`omp.goalMode` v1) reuses the RPC goal controller for its
 * lifecycle; this module holds the wire snapshots and the text-mode `/goal`
 * helpers the ACP agent needs on top of it.
 */
import type { Goal } from "@oh-my-pi/pi-tui/tools/goal";
import { formatCoarseDuration } from "@oh-my-pi/pi-tui/chrome/format";
import type { AvailableCommand, GoalModeArmed, GoalModeGoal } from "@oh-my-pi/pi-utils/acp";
import type { GoalModeState } from "../../goals/state";

export const ACP_GOAL_MODE_ID = "goal";
/** `goal.continuationModes` entry that enables goal continuation inside ACP prompts. */
export const ACP_GOAL_CONTINUATION_MODE = "acp";

export const GOAL_USAGE = "Usage: /goal [objective | set <objective> | show | pause | resume | drop | budget <N|off>]";

/** Run-mode commands the ACP agent handles itself (TUI-only builtins have no text-mode `handle`). */
export const ACP_GOAL_COMMANDS: AvailableCommand[] = [
	{
		name: "goal",
		description: "Set, show, pause, resume, or drop this session's goal",
		input: { hint: "[objective | set | show | pause | resume | drop | budget <N|off>]" },
	},
	{
		name: "guided-goal",
		description: "Interview to set up a goal, then work toward it",
		input: { hint: "[rough objective]" },
	},
];

export type GoalModeSnapshot = { goal: GoalModeGoal | null; armed: GoalModeArmed | null };

export function toAcpGoal(goal: Goal): GoalModeGoal {
	return {
		id: goal.id,
		objective: goal.objective,
		status: goal.status,
		...(goal.tokenBudget !== undefined ? { tokenBudget: goal.tokenBudget } : {}),
		tokensUsed: goal.tokensUsed,
		timeUsedSeconds: goal.timeUsedSeconds,
		createdAt: goal.createdAt,
		updatedAt: goal.updatedAt,
	};
}

/** Body of the `goal_update` session update. */
export function buildGoalModeSnapshot(
	state: GoalModeState | undefined,
	armed: GoalModeArmed | undefined,
): GoalModeSnapshot {
	return { goal: state ? toAcpGoal(state.goal) : null, armed: armed ?? null };
}

/** `_meta["omp.goalMode"]` on session responses. `active`: the session occupies the goal mode slot. */
export function buildGoalModeMeta(
	state: GoalModeState | undefined,
	armed: GoalModeArmed | undefined,
): GoalModeSnapshot & { version: 1; active: boolean } {
	return { version: 1, active: state !== undefined || armed !== undefined, ...buildGoalModeSnapshot(state, armed) };
}

/** `/goal show` text. */
export function formatGoalDetails(state: GoalModeState | undefined): string {
	const goal = state?.goal;
	if (!goal) return "No goal set. Use /goal <objective> to start one.";
	const used = goal.tokensUsed.toLocaleString();
	const tokens =
		goal.tokenBudget !== undefined
			? `${used} / ${goal.tokenBudget.toLocaleString()} (${Math.max(0, goal.tokenBudget - goal.tokensUsed).toLocaleString()} left)`
			: `${used} (no budget)`;
	return [
		`Objective: ${goal.objective}`,
		`Status: ${goal.status}${state.enabled ? "" : " (paused)"}`,
		`Tokens: ${tokens}`,
		`Time spent: ${formatCoarseDuration(goal.timeUsedSeconds * 1000)}`,
	].join("\n");
}

/** `/goal budget` argument: a positive integer, `off` (no budget), or invalid. */
export function parseGoalBudget(raw: string): { budget: number | undefined } | undefined {
	const trimmed = raw.trim().toLowerCase();
	if (trimmed === "off") return { budget: undefined };
	if (!/^\d+$/.test(trimmed)) return undefined;
	const parsed = Number.parseInt(trimmed, 10);
	return parsed > 0 ? { budget: parsed } : undefined;
}
