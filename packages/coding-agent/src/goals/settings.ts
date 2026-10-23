import { register } from "../config/registry";

export const cfgGoalEnabled = register({
	id: "goal.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "tasks",
		group: "Modes",
		label: "Goal Mode",
		description: "Enable per-session goal mode and the hidden goal tool",
	},
});

export const cfgGoalStatusInFooter = register({
	id: "goal.statusInFooter",
	type: "boolean",
	default: true,
	ui: {
		tab: "tasks",
		group: "Modes",
		label: "Goal Status in Footer",
		description: "Show token budget alongside the goal indicator in the status line",
	},
});

// ACP continues only inside a client `session/prompt` (the client sees and can
// cancel every goal turn), so it is on by default like the TUI.
const GOAL_CONTINUATION_MODES_DEFAULT: string[] = ["interactive", "acp"];

export const cfgGoalContinuationModes = register({
	id: "goal.continuationModes",
	type: "array",
	default: GOAL_CONTINUATION_MODES_DEFAULT,
	ui: {
		tab: "tasks",
		group: "Modes",
		label: "Goal Continuation Modes",
		description: 'Run modes where active goals may auto-continue between turns ("interactive", "acp", "rpc")',
	},
});
