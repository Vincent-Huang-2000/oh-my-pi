/**
 * ACP run modes beyond plan mode (see `docs/acp-run-modes.md`).
 *
 * Goal mode (`omp.goalMode` v1) reuses the RPC goal controller for its
 * lifecycle; this module holds the wire snapshots and the text-mode `/goal`
 * helpers the ACP agent needs on top of it. Vibe mode (`omp.vibeMode` v1)
 * mirrors the TUI's `/vibe` entry, exit, and reload against the session.
 */
import type { Goal } from "@oh-my-pi/pi-tui/tools/goal";
import { formatCoarseDuration } from "@oh-my-pi/pi-tui/chrome/format";
import type { AvailableCommand, GoalModeArmed, GoalModeGoal } from "@oh-my-pi/pi-utils/acp";
import { formatModelString } from "../../config/model-resolver";
import type { GoalModeState } from "../../goals/state";
import type { AgentSession } from "../../session/agent-session";
import { type VibeOwnerScope, type VibeParentSession, VibeSessionRegistry } from "../../vibe/runtime";

export const ACP_GOAL_MODE_ID = "goal";
export const ACP_VIBE_MODE_ID = "vibe";
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

export const ACP_VIBE_COMMANDS: AvailableCommand[] = [
	{
		name: "vibe",
		description: "Toggle vibe mode (direct persistent fast/good worker sessions; read-only toolset)",
		input: { hint: "[prompt]" },
	},
];

/** Live vibe mode: the tool set to restore on exit and the worker scope it owns. */
export type AcpVibeState = { previousTools: string[]; ownerScope: VibeOwnerScope };

/** `_meta["omp.vibeMode"]` on session responses. */
export function buildVibeModeMeta(active: boolean): { version: 1; active: boolean } {
	return { version: 1, active };
}

/** The worker-registry view of the director session (TUI `#vibeParentSession`). */
function vibeParentSession(session: AgentSession): VibeParentSession {
	return {
		getAgentId: () => session.getAgentId() ?? null,
		getSessionId: () => session.sessionManager.getSessionId(),
		getSessionFile: () => session.sessionManager.getSessionFile() ?? null,
		sessionManager: session.sessionManager,
		asyncJobManager: session.asyncJobManager,
		settings: session.settings,
		// Restored workers resolve against this session's active model, as on spawn.
		getActiveModelString: () => (session.model ? formatModelString(session.model) : undefined),
	};
}

/**
 * Enter vibe mode: activate the session's worker scope, reduce the tool set to
 * `read`, optional parent-owned `todo`, and the vibe tools, and inject the
 * director context. `persist: false` re-enters a journaled vibe session.
 */
export async function enterVibeMode(session: AgentSession, options?: { persist?: boolean }): Promise<AcpVibeState> {
	const registry = VibeSessionRegistry.global();
	const ownerScope = registry.ownerScope(vibeParentSession(session));
	registry.activateScope(ownerScope);
	const previousTools = session.getEnabledToolNames();
	const baseTools = ["read"];
	if (session.hasBuiltInTool("todo")) baseTools.push("todo");
	await session.activateVibeTools(baseTools);
	session.setVibeModeState({ enabled: true });
	if (session.isStreaming) await session.sendVibeModeContext({ deliverAs: "steer" });
	if (options?.persist !== false) session.sessionManager.appendModeChange("vibe", { previousTools });
	return { previousTools, ownerScope };
}

/**
 * Exit vibe mode: abort the director turn, kill every worker in the scope (which
 * journals the exit), and restore the pre-vibe tool set. Returns the kill count.
 */
export async function exitVibeMode(session: AgentSession, state: AcpVibeState): Promise<number> {
	let killed = 0;
	// Suppress queued-message replay so nothing restarts on the still-live vibe tools.
	await session.runModeExitTeardown(async () => {
		if (session.isStreaming) await session.abort();
		killed = await VibeSessionRegistry.global().killAll(vibeParentSession(session), state.ownerScope);
		await session.deactivateVibeTools(state.previousTools);
		session.setVibeModeState(undefined);
	});
	return killed;
}

/**
 * Leave the scope without ending it (session close, transcript switch): cancel
 * running worker turns but keep their transcripts, so a reload can rehydrate them.
 */
export async function suspendVibeMode(session: AgentSession, state: AcpVibeState): Promise<void> {
	await session.removeVibeToolsPreservingActive();
	session.setVibeModeState(undefined);
	await VibeSessionRegistry.global().suspendScope(state.ownerScope, session.asyncJobManager);
}

/** Re-enter a session whose journal is in vibe mode, rehydrating its parked workers. */
export async function restoreVibeMode(session: AgentSession): Promise<AcpVibeState> {
	await VibeSessionRegistry.global().rehydrate(vibeParentSession(session));
	return await enterVibeMode(session, { persist: false });
}

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
