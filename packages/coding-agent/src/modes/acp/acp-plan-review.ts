/**
 * ACP Plan Review extension (`omp.planReview` v1).
 *
 * The ACP protocol exposes plan approval as a blocking elicitation raised from
 * the plan-proposal handler. Rich clients (form-capable) additionally receive
 * a `plan_review_update` session update describing the full review — plan
 * content, selectable options, execution-model tiers, and context usage — and
 * may drive the review outside a pending elicitation via the
 * `omp.planReview/reopen` and `omp.planReview/action` extension methods.
 *
 * Pure helpers live here (parsing, validation, option construction) so they
 * can be tested without the ACP connection; file I/O and emission stay in
 * `acp-agent.ts`.
 */
import type { ContextUsage } from "../../extensibility/extensions";
import type { PlanReviewExecutionModel, PlanReviewOption } from "@oh-my-pi/pi-utils/acp";

/** Session-local filename backing the pending review state. The `plan\.md$`
 *  artifact scan ignores it, and it never collides with plan files. */
export const PLAN_REVIEW_STATE_FILE_NAME = ".omp-plan-review.json";

/** Context threshold above which "Approve and keep context" is disabled,
 *  mirroring InteractiveMode's `PLAN_KEEP_CONTEXT_DISABLE_THRESHOLD_PERCENT`. */
export const PLAN_REVIEW_KEEP_CONTEXT_DISABLE_THRESHOLD_PERCENT = 95;

export const PLAN_REVIEW_OPTION_LABELS: Record<PlanReviewOption["id"], string> = {
	execute: "Approve and execute",
	compact: "Approve and compact context",
	keep: "Approve and keep context",
	refine: "Refine plan",
	save: "Save and quit",
};

/** Review options advertised to ACP clients, with the keep-context tier
 *  disabled when the session context is too full to preserve. */
export function planReviewOptions(contextUsage: ContextUsage | undefined): PlanReviewOption[] {
	const keepDisabled =
		contextUsage !== undefined && contextUsage.percent > PLAN_REVIEW_KEEP_CONTEXT_DISABLE_THRESHOLD_PERCENT;
	return [
		{
			id: "execute",
			label: PLAN_REVIEW_OPTION_LABELS.execute,
			description: "Clears the conversation and starts a fresh session, then executes the plan.",
		},
		{
			id: "compact",
			label: PLAN_REVIEW_OPTION_LABELS.compact,
			description: "Distills the planning discussion, then executes in this session.",
		},
		{
			id: "keep",
			label: PLAN_REVIEW_OPTION_LABELS.keep,
			description: "Executes in this session with the full exploration history.",
			...(keepDisabled ? { disabled: true } : {}),
		},
		{
			id: "refine",
			label: PLAN_REVIEW_OPTION_LABELS.refine,
			description: "Keeps plan mode active and sends your feedback to the agent.",
		},
		{
			id: "save",
			label: PLAN_REVIEW_OPTION_LABELS.save,
			description: "Copies the plan to a chosen path, then starts a new session.",
		},
	];
}

/** Execution-model tiers selectable for the approved plan (session role-model
 *  cycle). Undefined when the cycle is empty or a lone tier — no choice. */
export function planReviewExecutionModels(
	cycle:
		| {
				models: Array<{ role: string; model: { name?: string; id: string } }>;
				currentIndex: number;
		  }
		| undefined,
): PlanReviewExecutionModel[] | undefined {
	if (!cycle || cycle.models.length <= 1) return undefined;
	const defaultIndex = cycle.models.findIndex(entry => entry.role === "default");
	const fallbackDefault = defaultIndex >= 0 ? defaultIndex : cycle.currentIndex;
	return cycle.models.map((entry, index) => ({
		id: entry.role,
		label: entry.model.name || entry.model.id,
		default: index === fallbackDefault,
	}));
}

/** Pending review state persisted next to the plan so the review survives
 *  session reloads and can be reopened outside the proposal elicitation. */
export interface AcpPlanReviewState {
	version: 1;
	reviewId: string;
	planFilePath: string;
	title: string;
	planExists: boolean;
	/** Refinement feedback accumulated while the review was open. */
	feedback: string;
}

/** Validate an untrusted payload against the persisted review-state shape. */
export function parsePlanReviewState(value: unknown): AcpPlanReviewState | null {
	if (typeof value !== "object" || value === null) return null;
	const record = value as Record<string, unknown>;
	if (record.version !== 1) return null;
	if (typeof record.reviewId !== "string" || record.reviewId.length === 0) return null;
	if (typeof record.planFilePath !== "string" || record.planFilePath.length === 0) return null;
	if (typeof record.title !== "string") return null;
	if (typeof record.planExists !== "boolean") return null;
	if (typeof record.feedback !== "string") return null;
	return {
		version: 1,
		reviewId: record.reviewId,
		planFilePath: record.planFilePath,
		title: record.title,
		planExists: record.planExists,
		feedback: record.feedback,
	};
}

/** Operator decision submitted through the review elicitation or the
 *  `omp.planReview/action` extension method. */
export type AcpPlanReviewDecision =
	| { kind: "approve"; strategy: "execute" | "compact" | "keep"; executionModel?: string; editedContent?: string }
	| { kind: "refine"; feedback: string; editedContent?: string }
	| { kind: "save"; savePath: string; editedContent?: string }
	| { kind: "cancel" }
	| { kind: "invalid"; reason: string };

/** 使用执行时的用量验证选择；界面禁用状态不能代替服务端检查。 */
export function validatePlanReviewDecision(
	decision: AcpPlanReviewDecision | undefined,
	contextUsage: ContextUsage | undefined,
): AcpPlanReviewDecision | undefined {
	if (
		decision?.kind === "approve" &&
		planReviewOptions(contextUsage).some(option => option.id === decision.strategy && option.disabled)
	) {
		return {
			kind: "invalid",
			reason: "Keeping context is unavailable above 95% usage. Choose another review option.",
		};
	}
	return decision;
}

/** A decision joined with the review identity and plan content it applies to. */
export type PlanReviewOutcome = Exclude<AcpPlanReviewDecision, { kind: "invalid" }> & {
	reviewId: string;
	planFilePath: string;
	title: string;
	content: string;
};

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
/** Map a raw elicitation/extension-method payload to a decision. Dismissal
 *  (undefined input) and unrecognized values yield `undefined`, which callers
 *  treat as cancel-with-refine-semantics: plan mode stays active and the
 *  review closes without granting write access. */
export function parsePlanReviewAction(content: Record<string, unknown> | undefined): AcpPlanReviewDecision | undefined {
	if (!content) return undefined;
	const decision = typeof content.decision === "string" ? content.decision : undefined;
	const feedback = optionalString(content.feedback);
	const savePath = optionalString(content.savePath);
	const executionModel = optionalString(content.executionModel);
	const editedContent = typeof content.editedContent === "string" ? content.editedContent : undefined;
	switch (decision) {
		case "execute":
		case "compact":
		case "keep":
			return { kind: "approve", strategy: decision, executionModel, editedContent };
		case "refine":
			return { kind: "refine", feedback: feedback ?? "", editedContent };
		case "save":
			if (!savePath) {
				return { kind: "invalid", reason: "Save and quit requires a save path." };
			}
			return { kind: "save", savePath, editedContent };
		case "cancel":
			return { kind: "cancel" };
		default:
			return undefined;
	}
}
