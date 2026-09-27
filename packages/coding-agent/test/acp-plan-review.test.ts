/**
 * Contract: ACP Plan Review (`omp.planReview` v1).
 *
 * Each test names the failure a consumer observes if it regresses — a wrong
 * decision mapping, a silent approval, a lost plan artifact, a review that
 * survives mode exit, or a session that reloads without its pending review.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ContextUsage } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { resolveLocalUrlToPath } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { AcpAgent } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-agent";
import { cfgPlanAutosave, cfgPlanEnabled } from "@oh-my-pi/pi-coding-agent/plan-mode/settings";
import {
	PLAN_REVIEW_OPTION_LABELS,
	parsePlanReviewAction,
	parsePlanReviewState,
	planReviewExecutionModels,
	planReviewOptions,
} from "@oh-my-pi/pi-coding-agent/modes/acp/acp-plan-review";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { ClientBridge } from "@oh-my-pi/pi-coding-agent/session/client-bridge";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { setAgentDir, getConfigRootDir } from "@oh-my-pi/pi-utils";
import type {
	AgentSideConnection,
	ClientCapabilities,
	CreateElicitationRequest,
	CreateElicitationResponse,
	SessionNotification,
	SessionUpdate,
} from "@oh-my-pi/pi-utils/acp";

/** Minimal AgentSession stub for the plan-review flow. Only the surface the
 *  ACP plan-review path touches is modeled; everything else is inert. */
class FakeAgentSession {
	sessionManager: SessionManager;
	sessionId: string;
	agent: { sessionId: string; waitForIdle: () => Promise<void> };
	isStreaming = false;
	skillsSettings = { enableSkillCommands: true };
	skills: [] = [];
	customCommands: [] = [];
	promptCalls: string[] = [];
	followUpCalls: string[] = [];
	compactCalls: Array<{ instructions: string | undefined; options: unknown }> = [];
	applyRoleModelCalls: Array<{ role: string }> = [];
	planModeState: { enabled: boolean; planFilePath: string; workflow?: string; reentry?: boolean } | undefined;
	planProposalHandler: ((title: string) => Promise<unknown> | unknown) | undefined;
	planReferencePath: string | undefined;
	planReferenceSent = false;
	markPlanReferenceSentCalls = 0;
	markPlanInternalAbortPendingCalls = 0;
	clearPlanInternalAbortPendingCalls = 0;
	sessionSwitchReconciler: (() => Promise<void>) | undefined;
	disposed = false;
	clientBridge: ClientBridge | undefined;
	contextUsage: ContextUsage | undefined;
	#listeners = new Set<(event: AgentSessionEvent) => void>();

	constructor(cwd: string) {
		this.sessionManager = SessionManager.create(cwd);
		this.sessionId = this.sessionManager.getSessionId();
		this.agent = {
			sessionId: this.sessionId,
			waitForIdle: async () => {},
		};
	}

	get settings(): Settings {
		return Settings.instance;
	}

	get sessionName(): string {
		return this.sessionManager.getHeader()?.title ?? `Session ${this.sessionId}`;
	}

	async prompt(text: string): Promise<boolean> {
		this.promptCalls.push(text);
		this.emit({ type: "agent_end", messages: [] } as AgentSessionEvent);
		return true;
	}

	emit(event: AgentSessionEvent): void {
		for (const listener of this.#listeners) listener(event);
	}

	async followUp(text: string): Promise<void> {
		this.followUpCalls.push(text);
	}

	async compact(instructions?: string, options?: unknown): Promise<void> {
		this.compactCalls.push({ instructions, options });
	}

	async applyRoleModel(entry: { role: string }): Promise<void> {
		this.applyRoleModelCalls.push(entry);
	}

	getRoleModelCycle(): undefined {
		return undefined;
	}

	async waitForIdle(): Promise<void> {}

	async drainAsyncJobDeliveriesForAcp(): Promise<boolean> {
		return false;
	}

	getContextUsage(): ContextUsage | undefined {
		return this.contextUsage;
	}

	getPlanModeState(): FakeAgentSession["planModeState"] {
		return this.planModeState;
	}

	setPlanModeState(state: FakeAgentSession["planModeState"]): void {
		this.planModeState = state;
	}

	setPlanProposalHandler(handler: ((title: string) => Promise<unknown> | unknown) | null): void {
		this.planProposalHandler = handler ?? undefined;
	}

	setPlanReferencePath(planFilePath: string): void {
		this.planReferencePath = planFilePath;
	}

	markPlanReferenceSent(): void {
		this.markPlanReferenceSentCalls++;
		this.planReferenceSent = true;
	}

	markPlanInternalAbortPending(): void {
		this.markPlanInternalAbortPendingCalls++;
	}

	clearPlanInternalAbortPending(): void {
		this.clearPlanInternalAbortPendingCalls++;
	}

	async abort(): Promise<void> {
		this.isStreaming = false;
	}

	async newSession(): Promise<boolean> {
		await this.sessionManager.newSession();
		this.sessionId = this.sessionManager.getSessionId();
		this.agent.sessionId = this.sessionId;
		this.planReferencePath = "local://PLAN.md";
		return true;
	}

	async switchSession(sessionPath: string): Promise<boolean> {
		await this.sessionManager.setSessionFile(sessionPath);
		this.sessionId = this.sessionManager.getSessionId();
		this.agent.sessionId = this.sessionId;
		await this.sessionSwitchReconciler?.();
		return true;
	}

	setSessionSwitchReconciler(reconciler: (() => Promise<void>) | null): void {
		this.sessionSwitchReconciler = reconciler ?? undefined;
	}

	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}
	subscribeCommandMetadataChanged(): () => void {
		return () => {};
	}

	setClientBridge(bridge: ClientBridge): void {
		this.clientBridge = bridge;
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		await this.sessionManager.close();
	}

	setSlashCommands(): void {}
	setUsageFallbackConfirmer(): void {}
	getAvailableModels(): [] {
		return [];
	}
	getAvailableThinkingLevels(): string[] {
		return [];
	}
	setThinkingLevel(): void {}
	setModel(): Promise<void> {
		return Promise.resolve();
	}
	refreshSkills(): Promise<void> {
		return Promise.resolve();
	}
	async refreshMCPTools(): Promise<void> {}
	getToolByName(): undefined {
		return undefined;
	}
}

interface Harness {
	agent: AcpAgent;
	updates: SessionNotification[];
	abortController: AbortController;
	sessions: FakeAgentSession[];
	cwd: string;
	findSession(sessionId: string): FakeAgentSession | undefined;
	localRoot(sessionId: string): string;
}

const cleanupRoots: string[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

afterEach(async () => {
	if (originalAgentDir) {
		setAgentDir(originalAgentDir);
	} else {
		setAgentDir(fallbackAgentDir);
		delete process.env.PI_CODING_AGENT_DIR;
	}
	resetSettingsForTest();
	for (const root of cleanupRoots.splice(0)) {
		await fs.promises.rm(root, { recursive: true, force: true });
	}
});

async function createHarness(
	options: {
		elicitationHandler?: (req: CreateElicitationRequest) => Promise<CreateElicitationResponse>;
		clientCapabilities?: ClientCapabilities;
		readTextFile?: (sessionId: string) => void;
	} = {},
): Promise<Harness> {
	const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-acp-plan-review-"));
	cleanupRoots.push(root);
	const agentDir = path.join(root, "agent");
	const cwd = path.join(root, "cwd");
	await fs.promises.mkdir(agentDir, { recursive: true });
	await fs.promises.mkdir(cwd, { recursive: true });
	setAgentDir(agentDir);
	await Settings.init({ agentDir, inMemory: true });

	const updates: SessionNotification[] = [];
	const abortController = new AbortController();
	const sessions: FakeAgentSession[] = [];
	const connection = {
		readTextFile: async (params: { sessionId: string }) => {
			options.readTextFile?.(params.sessionId);
			return { content: "workspace file" };
		},
		sessionUpdate: async (notification: SessionNotification) => {
			updates.push(notification);
		},
		unstable_createElicitation: options.elicitationHandler
			? async (req: CreateElicitationRequest) => options.elicitationHandler!(req)
			: undefined,
		signal: abortController.signal,
		closed: Promise.withResolvers<void>().promise,
	} as unknown as AgentSideConnection;

	const factory = async (factoryCwd: string) => {
		const session = new FakeAgentSession(factoryCwd);
		sessions.push(session);
		return { session: session as unknown as AgentSession, setToolUIContext: () => {} };
	};

	const initialSession = new FakeAgentSession(cwd);
	sessions.push(initialSession);
	const agent = new AcpAgent(connection, factory, initialSession as unknown as AgentSession);
	const clientCapabilities =
		options.clientCapabilities ?? (options.elicitationHandler ? { elicitation: { form: {} } } : undefined);
	if (clientCapabilities) {
		await agent.initialize({
			protocolVersion: 1,
			clientCapabilities,
		} as Parameters<typeof agent.initialize>[0]);
	}

	const localRoot = (sessionId: string): string =>
		resolveLocalUrlToPath("local://", {
			getArtifactsDir: () => {
				const record = sessions.find(candidate => candidate.sessionId === sessionId);
				return (record ?? sessions[0])!.sessionManager.getArtifactsDir();
			},
			getSessionId: () => sessionId,
		});

	return {
		agent,
		updates,
		abortController,
		sessions,
		cwd,
		findSession: (sessionId: string) => sessions.find(candidate => candidate.sessionId === sessionId),
		localRoot,
	};
}

async function createPlanSession(harness: Harness): Promise<{
	created: { sessionId: string };
	session: FakeAgentSession;
	planUrl: string;
}> {
	cfgPlanEnabled.set(Settings.instance, true);
	const created = await harness.agent.newSession({ cwd: harness.cwd, mcpServers: [] });
	const session = harness.findSession(created.sessionId)!;
	await harness.agent.setSessionMode({ sessionId: created.sessionId, modeId: "plan" });
	const localRoot = resolveLocalUrlToPath("local://", {
		getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
		getSessionId: () => session.sessionManager.getSessionId(),
	});
	cleanupRoots.push(localRoot);
	await Bun.write(path.join(localRoot, "words-counter-plan.md"), "# Words Counter\n\nFile contents.");
	return { created, session, planUrl: "local://words-counter-plan.md" };
}

function reviewUpdates(
	updates: SessionNotification[],
): Array<Extract<SessionUpdate, { sessionUpdate: "plan_review_update" }>> {
	return updates.flatMap(notification =>
		notification.update.sessionUpdate === "plan_review_update" ? [notification.update] : [],
	);
}

/** Narrow an unknown value to a field-typed record via an existing invariant:
 *  `session.compact`'s options object carries `internalGuidance`. */
function internalGuidanceOf(options: unknown): string | undefined {
	return typeof options === "object" &&
		options !== null &&
		"internalGuidance" in options &&
		typeof options.internalGuidance === "string"
		? options.internalGuidance
		: undefined;
}

describe("parsePlanReviewAction", () => {
	it("maps each option id to its decision and carries optional fields", () => {
		expect(parsePlanReviewAction({ decision: "execute" })).toEqual({ kind: "approve", strategy: "execute" });
		expect(parsePlanReviewAction({ decision: "compact", executionModel: "slow", editedContent: "# New" })).toEqual({
			kind: "approve",
			strategy: "compact",
			executionModel: "slow",
			editedContent: "# New",
		});
		expect(parsePlanReviewAction({ decision: "keep" })).toEqual({ kind: "approve", strategy: "keep" });
		expect(parsePlanReviewAction({ decision: "refine", feedback: "  shorten it  " })).toEqual({
			kind: "refine",
			feedback: "shorten it",
			editedContent: undefined,
		});
		expect(parsePlanReviewAction({ decision: "save", savePath: "docs/plan.md" })).toEqual({
			kind: "save",
			savePath: "docs/plan.md",
			editedContent: undefined,
		});
		expect(parsePlanReviewAction({ decision: "cancel" })).toEqual({ kind: "cancel" });
	});

	it("rejects save without a path instead of silently dropping the plan", () => {
		expect(parsePlanReviewAction({ decision: "save" })).toEqual({
			kind: "invalid",
			reason: "Save and quit requires a save path.",
		});
		expect(parsePlanReviewAction({ decision: "save", savePath: "   " })).toEqual({
			kind: "invalid",
			reason: "Save and quit requires a save path.",
		});
	});

	it("treats dismissal and unknown decisions as undefined, never as approval", () => {
		expect(parsePlanReviewAction(undefined)).toBeUndefined();
		expect(parsePlanReviewAction({})).toBeUndefined();
		expect(parsePlanReviewAction({ decision: "Approve and execute" })).toBeUndefined();
		expect(parsePlanReviewAction({ decision: "execute", feedback: 42 })).toEqual({
			kind: "approve",
			strategy: "execute",
		});
	});
});

describe("parsePlanReviewState", () => {
	it("accepts the v1 persisted shape", () => {
		expect(
			parsePlanReviewState({
				version: 1,
				reviewId: "r1",
				planFilePath: "local://x-plan.md",
				title: "x",
				planExists: true,
				feedback: "f",
			}),
		).toEqual({
			version: 1,
			reviewId: "r1",
			planFilePath: "local://x-plan.md",
			title: "x",
			planExists: true,
			feedback: "f",
		});
	});

	it("rejects foreign versions and malformed payloads", () => {
		expect(
			parsePlanReviewState({
				version: 2,
				reviewId: "r1",
				planFilePath: "p",
				title: "t",
				planExists: true,
				feedback: "",
			}),
		).toBeNull();
		expect(
			parsePlanReviewState({
				version: 1,
				reviewId: "",
				planFilePath: "p",
				title: "t",
				planExists: true,
				feedback: "",
			}),
		).toBeNull();
		expect(
			parsePlanReviewState({
				version: 1,
				reviewId: "r1",
				planFilePath: "p",
				title: "t",
				planExists: "yes",
				feedback: "",
			}),
		).toBeNull();
		expect(parsePlanReviewState(null)).toBeNull();
	});
});

describe("planReviewOptions", () => {
	it("advertises all five option ids with stable labels", () => {
		const options = planReviewOptions(undefined);
		expect(options.map(option => option.id)).toEqual(["execute", "compact", "keep", "refine", "save"]);
		expect(options.map(option => option.label)).toEqual([
			PLAN_REVIEW_OPTION_LABELS.execute,
			PLAN_REVIEW_OPTION_LABELS.compact,
			PLAN_REVIEW_OPTION_LABELS.keep,
			PLAN_REVIEW_OPTION_LABELS.refine,
			PLAN_REVIEW_OPTION_LABELS.save,
		]);
		expect(options.every(option => option.disabled !== true)).toBe(true);
	});

	it("disables keep-context only above the 95% threshold", () => {
		const disabled = planReviewOptions({ tokens: 190_000, contextWindow: 200_000, percent: 96 });
		expect(disabled.find(option => option.id === "keep")?.disabled).toBe(true);
		const enabled = planReviewOptions({ tokens: 190_000, contextWindow: 200_000, percent: 95 });
		expect(enabled.find(option => option.id === "keep")?.disabled).toBeUndefined();
	});
});

describe("planReviewExecutionModels", () => {
	it("marks the default tier and omits singleton cycles", () => {
		const cycle = {
			currentIndex: 0,
			models: [
				{ role: "default", model: { id: "a", name: "A" } },
				{ role: "slow", model: { id: "b", name: "B" } },
			],
		};
		expect(planReviewExecutionModels(cycle)).toEqual([
			{ id: "default", label: "A", default: true },
			{ id: "slow", label: "B", default: false },
		]);
		expect(planReviewExecutionModels({ currentIndex: 0, models: [cycle.models[0]!] })).toBeUndefined();
		expect(planReviewExecutionModels(undefined)).toBeUndefined();
	});
});

describe("ACP plan review", () => {
	it.each(["execute", "compact", "keep", "save"])(
		"completes deferred %s inside the owning prompt at the allowed context boundary",
		async decision => {
			const harness = await createHarness({
				elicitationHandler: async () => ({
					action: "accept",
					content: { decision, editedContent: "approved edit", savePath: "approved-plan.md" },
				}),
			});
			try {
				const { created, session } = await createPlanSession(harness);
				cfgPlanAutosave.set(Settings.instance, true);
				session.contextUsage = { tokens: 190000, contextWindow: 200000, percent: 95 };
				const originalPrompt = session.prompt.bind(session);
				let submitted = false;
				session.prompt = async text => {
					if (submitted) return originalPrompt(text);
					submitted = true;
					session.isStreaming = true;
					await session.planProposalHandler!("words-counter");
					session.emit({ type: "agent_end", messages: [] } as AgentSessionEvent);
					return true;
				};
				const result = await harness.agent.prompt({
					sessionId: created.sessionId,
					prompt: [{ type: "text", text: "propose the plan" }],
				});
				expect(result.stopReason).toBe("end_turn");
				expect(session.markPlanInternalAbortPendingCalls).toBe(1);
				expect(session.planModeState).toBeUndefined();
				expect(session.promptCalls.length).toBe(decision === "save" ? 0 : 1);
				const planPath =
					decision === "save"
						? path.join(harness.cwd, "approved-plan.md")
						: path.join(harness.localRoot(session.sessionId), "words-counter-plan.md");
				expect(await Bun.file(planPath).text()).toBe("approved edit");
				if (decision !== "save") {
					expect(session.promptCalls[0]).toContain(
						`<plan path="local://words-counter-plan.md">\napproved edit\n</plan>`,
					);
				}
				const autosavedPath = path.join(harness.cwd, ".omp", "plans", "WORDS_COUNTER_PLAN.md");
				expect(await Bun.file(autosavedPath).exists()).toBe(decision !== "save");
				if (decision !== "save") expect(await Bun.file(autosavedPath).text()).toBe("approved edit");
				expect(session.compactCalls.length).toBe(decision === "compact" ? 1 : 0);
				expect(session.sessionId === created.sessionId).toBe(decision === "compact" || decision === "keep");
			} finally {
				harness.abortController.abort();
				await Bun.sleep(0);
			}
		},
	);

	it("rejects deferred keep at agent_end and settles the prompt without dispatching execution", async () => {
		const harness = await createHarness({
			elicitationHandler: async () => ({
				action: "accept",
				content: { decision: "keep", editedContent: "unapproved edit" },
			}),
		});
		try {
			const { created, session } = await createPlanSession(harness);
			session.contextUsage = { tokens: 190000, contextWindow: 200000, percent: 95 };
			const originalPrompt = session.prompt.bind(session);
			let submitted = false;
			session.prompt = async text => {
				if (submitted) return originalPrompt(text);
				submitted = true;
				session.isStreaming = true;
				await session.planProposalHandler!("words-counter");
				session.contextUsage = { tokens: 196000, contextWindow: 200000, percent: 98 };
				session.emit({ type: "agent_end", messages: [] } as AgentSessionEvent);
				return true;
			};
			const result = await harness.agent.prompt({
				sessionId: created.sessionId,
				prompt: [{ type: "text", text: "propose the plan" }],
			});
			expect(result.stopReason).toBe("end_turn");
			expect(session.markPlanInternalAbortPendingCalls).toBe(1);
			expect(session.promptCalls).toEqual([]);
			expect(session.planModeState?.enabled).toBe(true);
			expect(
				harness.updates.some(
					notification =>
						notification.update.sessionUpdate === "agent_message_chunk" &&
						notification.update.content.type === "text" &&
						notification.update.content.text.includes("95%"),
				),
			).toBe(true);
			expect((await harness.agent.extMethod("omp.planReview/reopen", { sessionId: created.sessionId })).ok).toBe(
				true,
			);
			expect(reviewUpdates(harness.updates).at(-1)?.review?.content).toContain("File contents.");
		} finally {
			harness.abortController.abort();
			await Bun.sleep(0);
		}
	});

	it("rejects a keep response when usage grew while the review was open, preserving edits and review state", async () => {
		let session: FakeAgentSession;
		let offeredKeep = false;
		const harness = await createHarness({
			elicitationHandler: async request => {
				const choices = request.mode === "form" ? request.requestedSchema?.properties.decision?.oneOf : undefined;
				offeredKeep =
					Array.isArray(choices) &&
					choices.some(
						option =>
							typeof option === "object" && option !== null && "const" in option && option.const === "keep",
					);
				session.contextUsage = { tokens: 196000, contextWindow: 200000, percent: 98 };
				return { action: "accept", content: { decision: "keep", editedContent: "unapproved edit" } };
			},
		});
		try {
			const created = await createPlanSession(harness);
			session = created.session;
			session.contextUsage = { tokens: 190000, contextWindow: 200000, percent: 95 };
			await session.planProposalHandler!("words-counter");
			expect(offeredKeep).toBe(true);
			expect(session.planModeState?.enabled).toBe(true);
			expect(session.promptCalls).toEqual([]);
			expect(
				(await harness.agent.extMethod("omp.planReview/reopen", { sessionId: created.created.sessionId })).ok,
			).toBe(true);
			expect(reviewUpdates(harness.updates).at(-1)?.review?.content).toContain("File contents.");
		} finally {
			harness.abortController.abort();
			await Bun.sleep(0);
		}
	});

	it("rejects disabled keep actions but accepts the 95 percent boundary without consuming a rejected review", async () => {
		const harness = await createHarness({
			elicitationHandler: async () => ({ action: "accept", content: { decision: "refine" } }),
		});
		try {
			const { created, session } = await createPlanSession(harness);
			await session.planProposalHandler!("words-counter");
			const { reviewId } = await harness.agent.extMethod("omp.planReview/reopen", { sessionId: created.sessionId });
			const params = { sessionId: created.sessionId, reviewId, decision: "keep" };
			session.contextUsage = { tokens: 196000, contextWindow: 200000, percent: 98 };
			const rejected = await harness.agent.extMethod("omp.planReview/action", params);
			expect(rejected.ok).toBe(false);
			expect(rejected.error).toContain("95%");
			expect(session.planModeState?.enabled).toBe(true);
			expect(session.promptCalls).toEqual([]);
			session.contextUsage = { tokens: 190000, contextWindow: 200000, percent: 95 };
			expect(await harness.agent.extMethod("omp.planReview/action", params)).toEqual({ ok: true });
			expect(session.planModeState).toBeUndefined();
			expect(session.promptCalls.length).toBe(1);
		} finally {
			harness.abortController.abort();
			await Bun.sleep(0);
		}
	});

	it("rechecks keep after waiting for idle before applying any decision side effects", async () => {
		const harness = await createHarness({
			elicitationHandler: async () => ({ action: "accept", content: { decision: "refine" } }),
		});
		try {
			const { created, session } = await createPlanSession(harness);
			await session.planProposalHandler!("words-counter");
			const { reviewId } = await harness.agent.extMethod("omp.planReview/reopen", { sessionId: created.sessionId });
			session.contextUsage = { tokens: 190000, contextWindow: 200000, percent: 95 };
			session.waitForIdle = async () => {
				session.contextUsage = { tokens: 196000, contextWindow: 200000, percent: 98 };
			};
			const rejected = await harness.agent.extMethod("omp.planReview/action", {
				sessionId: created.sessionId,
				reviewId,
				decision: "keep",
				editedContent: "unapproved edit",
			});
			expect(rejected.ok).toBe(false);
			expect(rejected.error).toContain("95%");
			expect(session.planModeState?.enabled).toBe(true);
			expect(session.promptCalls).toEqual([]);
			expect(
				(await harness.agent.extMethod("omp.planReview/reopen", { sessionId: created.sessionId })).reviewId,
			).toBe(reviewId);
			expect(reviewUpdates(harness.updates).at(-1)?.review?.content).toContain("File contents.");
		} finally {
			harness.abortController.abort();
			await Bun.sleep(0);
		}
	});

	it("does not reactivate an old plan after plan support is disabled and re-enabled", async () => {
		const harness = await createHarness();
		try {
			const { created } = await createPlanSession(harness);
			const params = { sessionId: created.sessionId, cwd: harness.cwd, mcpServers: [] };
			await harness.agent.closeSession({ sessionId: created.sessionId });
			cfgPlanEnabled.set(Settings.instance, false);
			expect((await harness.agent.loadSession(params)).modes?.currentModeId).toBe("default");
			await harness.agent.closeSession({ sessionId: created.sessionId });
			cfgPlanEnabled.set(Settings.instance, true);
			expect((await harness.agent.loadSession(params)).modes?.currentModeId).toBe("default");
		} finally {
			harness.abortController.abort();
			await Bun.sleep(0);
		}
	});
	it.each(["load", "resume"])("restores planning before the first proposal through %s", async method => {
		const harness = await createHarness();
		try {
			const { created } = await createPlanSession(harness);
			await harness.agent.closeSession({ sessionId: created.sessionId });
			const params = { sessionId: created.sessionId, cwd: harness.cwd, mcpServers: [] };
			const restored =
				method === "load" ? await harness.agent.loadSession(params) : await harness.agent.resumeSession(params);
			expect(restored.modes?.currentModeId).toBe("plan");
			expect(restored._meta?.["omp.planMode"]).toEqual({
				version: 1,
				active: true,
				planFilePath: "local://PLAN.md",
				content: null,
			});
			expect(restored._meta?.["omp.planReview"]).toEqual({ version: 1, active: false });
			const loaded = harness.sessions.at(-1)!;
			await loaded.planProposalHandler!("words-counter");
			expect(loaded.planReferencePath).toBe("local://words-counter-plan.md");
		} finally {
			harness.abortController.abort();
			await Bun.sleep(0);
		}
	});

	it("restores the reviewed path after dismissal without resurrecting the dismissed review", async () => {
		const harness = await createHarness({ elicitationHandler: async () => ({ action: "cancel" }) });
		try {
			const { created, session, planUrl } = await createPlanSession(harness);
			await session.planProposalHandler!("words-counter");
			await harness.agent.closeSession({ sessionId: created.sessionId });
			const restored = await harness.agent.loadSession({
				sessionId: created.sessionId,
				cwd: harness.cwd,
				mcpServers: [],
			});
			expect(restored.modes?.currentModeId).toBe("plan");
			expect(harness.sessions.at(-1)!.planModeState?.planFilePath).toBe(planUrl);
			expect(restored._meta?.["omp.planReview"]).toEqual({ version: 1, active: false });
		} finally {
			harness.abortController.abort();
			await Bun.sleep(0);
		}
	});

	it("keeps missing-plan sessions in plan mode but does not restore missing or explicitly consumed reviews", async () => {
		const harness = await createHarness({
			elicitationHandler: async () => ({ action: "accept", content: { decision: "refine" } }),
		});
		try {
			const { created, session } = await createPlanSession(harness);
			await session.planProposalHandler!("words-counter");
			await fs.promises.unlink(path.join(harness.localRoot(created.sessionId), "words-counter-plan.md"));
			await harness.agent.closeSession({ sessionId: created.sessionId });
			const params = { sessionId: created.sessionId, cwd: harness.cwd, mcpServers: [] };
			const restored = await harness.agent.loadSession(params);
			expect(restored.modes?.currentModeId).toBe("plan");
			expect(restored._meta?.["omp.planReview"]).toEqual({ version: 1, active: false });
			await harness.agent.setSessionMode({ sessionId: created.sessionId, modeId: "default" });
			await harness.agent.closeSession({ sessionId: created.sessionId });
			expect((await harness.agent.loadSession(params)).modes?.currentModeId).toBe("default");
		} finally {
			harness.abortController.abort();
			await Bun.sleep(0);
		}
	});

	it.each(["refine", "keep", "cancel"])(
		"ignores late %s after mode exit without touching a newer review",
		async decision => {
			const pending = Promise.withResolvers<CreateElicitationResponse>();
			const opened = Promise.withResolvers<void>();
			let first = true;
			const harness = await createHarness({
				elicitationHandler: async () => {
					if (first) {
						first = false;
						opened.resolve();
						return await pending.promise;
					}
					return { action: "accept", content: { decision: "refine", feedback: "new review" } };
				},
			});
			try {
				const { created, session, planUrl } = await createPlanSession(harness);
				const proposal = session.planProposalHandler!("words-counter");
				await opened.promise;
				await harness.agent.setSessionMode({ sessionId: created.sessionId, modeId: "default" });
				expect(reviewUpdates(harness.updates).at(-1)?.review).toBeNull();
				await harness.agent.setSessionMode({ sessionId: created.sessionId, modeId: "plan" });
				await session.planProposalHandler!("words-counter");
				const current = await harness.agent.extMethod("omp.planReview/reopen", { sessionId: created.sessionId });
				const before = harness.updates.length;
				pending.resolve({
					action: "accept",
					content: { decision, feedback: "stale feedback", editedContent: "stale edit" },
				});
				await proposal;
				expect(session.planModeState?.enabled).toBe(true);
				expect(harness.updates.length).toBe(before);
				const reopened = await harness.agent.extMethod("omp.planReview/reopen", { sessionId: created.sessionId });
				expect(reopened).toEqual(current);
				expect(reviewUpdates(harness.updates).at(-1)?.review?.feedback).toBe("new review");
				expect(
					await Bun.file(path.join(harness.localRoot(created.sessionId), planUrl.slice("local://".length))).text(),
				).toContain("File contents.");
			} finally {
				harness.abortController.abort();
				await Bun.sleep(0);
			}
		},
	);

	it("does not resurrect a pending review from a refine response after mode exit", async () => {
		const pending = Promise.withResolvers<CreateElicitationResponse>();
		const opened = Promise.withResolvers<void>();
		const harness = await createHarness({
			elicitationHandler: async () => {
				opened.resolve();
				return await pending.promise;
			},
		});
		try {
			const { created, session } = await createPlanSession(harness);
			const proposal = session.planProposalHandler!("words-counter");
			await opened.promise;
			await harness.agent.setSessionMode({ sessionId: created.sessionId, modeId: "default" });
			pending.resolve({ action: "accept", content: { decision: "refine", feedback: "late feedback" } });
			await proposal;
			expect(await harness.agent.extMethod("omp.planReview/reopen", { sessionId: created.sessionId })).toEqual({
				ok: false,
				error: "No pending plan review for this session.",
			});
			await harness.agent.closeSession({ sessionId: created.sessionId });
			const loaded = await harness.agent.loadSession({
				sessionId: created.sessionId,
				cwd: harness.cwd,
				mcpServers: [],
			});
			expect(loaded.modes?.currentModeId).toBe("default");
		} finally {
			harness.abortController.abort();
			await Bun.sleep(0);
		}
	});

	it.each(["execute", "save"])(
		"hands off the ACP identity after %s and accepts subsequent requests",
		async decision => {
			const readSessionIds: string[] = [];
			const harness = await createHarness({
				elicitationHandler: async () => ({ action: "accept", content: { decision, savePath: "saved-plan.md" } }),
				clientCapabilities: { elicitation: { form: {} }, fs: { readTextFile: true } },
				readTextFile: sessionId => {
					readSessionIds.push(sessionId);
				},
			});
			try {
				const { created, session } = await createPlanSession(harness);
				await session.planProposalHandler!("words-counter");
				const replacementIndex = harness.updates.findIndex(
					notification => notification.update._meta?.["omp.sessionReplacement"] !== undefined,
				);
				const replacement = harness.updates[replacementIndex]!;
				expect(replacement.sessionId).toBe(created.sessionId);
				expect(replacement.update._meta?.["omp.sessionReplacement"]).toEqual({
					version: 1,
					sessionId: session.sessionId,
				});
				expect(
					harness.updates.slice(0, replacementIndex).every(update => update.sessionId === created.sessionId),
				).toBe(true);
				await harness.agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "continue" }] });
				await harness.agent.setSessionMode({ sessionId: session.sessionId, modeId: "plan" });
				await session.clientBridge!.readTextFile!({ path: "README.md" });
				expect(readSessionIds).toEqual([session.sessionId]);
				expect(
					harness.updates.slice(replacementIndex + 1).every(update => update.sessionId === session.sessionId),
				).toBe(true);
				await harness.agent.closeSession({ sessionId: session.sessionId });
				expect(session.disposed).toBe(true);
			} finally {
				harness.abortController.abort();
				await Bun.sleep(0);
			}
		},
	);

	it("opens a full review for form-capable clients and executes the fresh-session strategy", async () => {
		let captured: CreateElicitationRequest | undefined;
		const harness = await createHarness({
			elicitationHandler: async req => {
				captured = req;
				return { action: "accept", content: { decision: "execute" } };
			},
		});
		const { created, session, planUrl } = await createPlanSession(harness);
		const updatesBefore = harness.updates.length;

		const handler = session.planProposalHandler!;
		const result = (await handler("words-counter")) as {
			content: Array<{ text: string }>;
			details: { planFilePath: string };
		};

		// The review update arrived before the elicitation, with full content.
		const opened = reviewUpdates(harness.updates.slice(updatesBefore));
		expect(opened.length).toBeGreaterThanOrEqual(1);
		const review = opened[0]!.review!;
		expect(review.planFilePath).toBe(planUrl);
		expect(review.title).toBe("words-counter");
		expect(review.planExists).toBe(true);
		expect(review.content).toContain("File contents.");
		expect(review.options.map(option => option.id)).toEqual(["execute", "compact", "keep", "refine", "save"]);

		// The elicitation carries the decision schema and optional fields.
		expect(captured?.mode).toBe("form");
		const schema = captured?.mode === "form" ? captured.requestedSchema : undefined;
		expect(schema?.type).toBe("object");
		const properties = schema?.properties;
		const oneOf = properties?.decision?.oneOf;
		const decisionIds = Array.isArray(oneOf)
			? oneOf
					.filter(
						(entry): entry is { const: string } =>
							typeof entry === "object" && entry !== null && typeof entry.const === "string",
					)
					.map(entry => entry.const)
			: [];
		expect(decisionIds).toEqual(["execute", "compact", "keep", "refine", "save"]);
		expect(properties?.feedback).toBeDefined();
		expect(properties?.savePath).toBeDefined();
		expect(properties?.editedContent).toBeDefined();
		// Fresh-session execution: plan mode exits, a new session id takes
		// over, the plan survives into the new artifact root, the review state
		// is consumed, and the synthetic approved-prompt turn is dispatched.
		expect(session.planModeState).toBeUndefined();
		expect(session.planProposalHandler).toBeUndefined();
		expect(session.sessionId).not.toBe(created.sessionId);
		expect(session.planReferencePath).toBe(planUrl);
		expect(session.markPlanReferenceSentCalls).toBe(1);
		const newRoot = harness.localRoot(session.sessionId);
		expect(await Bun.file(path.join(newRoot, "words-counter-plan.md")).exists()).toBe(true);
		expect(await Bun.file(path.join(newRoot, ".omp-plan-review.json")).exists()).toBe(false);
		const approvedPrompt = session.promptCalls.join("\n");
		expect(approvedPrompt).toContain("Plan approved.");
		expect(approvedPrompt).toContain(planUrl);
		// contextPreserved: false renders no "History usable" line.
		expect(approvedPrompt).not.toContain("History usable");
		expect(reviewUpdates(harness.updates.slice(updatesBefore)).some(update => update.review === null)).toBe(true);
		expect(result.details.planFilePath).toBe(planUrl);
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("compacts before executing when the compact strategy is chosen", async () => {
		const harness = await createHarness({
			elicitationHandler: async () => ({ action: "accept", content: { decision: "compact" } }),
		});
		const { created, session, planUrl } = await createPlanSession(harness);

		await session.planProposalHandler!("words-counter");

		expect(session.planModeState).toBeUndefined();
		expect(session.sessionId).toBe(created.sessionId);
		expect(session.compactCalls.length).toBe(1);
		const guidance = internalGuidanceOf(session.compactCalls[0]!.options);
		expect(typeof guidance).toBe("string");
		expect(guidance).toContain(planUrl);
		const approvedPrompt = session.promptCalls.join("\n");
		expect(approvedPrompt).toContain("Plan approved.");
		// contextPreserved: true renders the "History usable" line.
		expect(approvedPrompt).toContain("History usable");
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("keeps context inline: plain keep approval continues the current turn without a synthetic dispatch", async () => {
		const harness = await createHarness({
			elicitationHandler: async () => ({ action: "accept", content: { decision: "keep" } }),
		});
		const { session } = await createPlanSession(harness);

		const result = (await session.planProposalHandler!("words-counter")) as {
			content: Array<{ text: string }>;
		};

		expect(result.content[0]?.text).toMatch(/Plan approved/);
		expect(session.planModeState).toBeUndefined();
		expect(session.planProposalHandler).toBeUndefined();
		expect(session.planReferencePath).toBe("local://words-counter-plan.md");
		expect(session.markPlanReferenceSentCalls).toBe(0);
		expect(session.promptCalls.length).toBe(0);
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("refine keeps plan mode active, feeds the operator feedback back, and persists the review for reopen", async () => {
		const harness = await createHarness({
			elicitationHandler: async () => ({
				action: "accept",
				content: { decision: "refine", feedback: "shorten section 3" },
			}),
		});
		const { created, session } = await createPlanSession(harness);

		const result = (await session.planProposalHandler!("words-counter")) as {
			content: Array<{ text: string }>;
		};
		const capturedReviewId = reviewUpdates(harness.updates).at(-2)?.review?.reviewId;

		expect(result.content[0]?.text).toContain("shorten section 3");
		expect(session.planModeState?.enabled).toBe(true);
		expect(typeof session.planProposalHandler).toBe("function");
		expect(session.planReferencePath).toBeUndefined();

		// The pending review survives and reopens with the accumulated feedback.
		const updatesBefore = harness.updates.length;
		const reopen = await harness.agent.extMethod("omp.planReview/reopen", { sessionId: created.sessionId });
		expect(reopen).toEqual({ ok: true, reviewId: capturedReviewId });
		const reopened = reviewUpdates(harness.updates.slice(updatesBefore));
		expect(reopened[0]?.review?.feedback).toBe("shorten section 3");
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("save writes the plan to the requested workspace path and starts a fresh session", async () => {
		const harness = await createHarness({
			elicitationHandler: async () => ({
				action: "accept",
				content: { decision: "save", savePath: "docs/my-plan.md" },
			}),
		});
		const { created, session } = await createPlanSession(harness);

		await session.planProposalHandler!("words-counter");

		expect(await Bun.file(path.join(harness.cwd, "docs", "my-plan.md")).text()).toContain("File contents.");
		expect(session.planModeState).toBeUndefined();
		expect(session.sessionId).not.toBe(created.sessionId);
		expect(session.promptCalls.length).toBe(0);
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("restores a pending review and plan mode when the session reloads", async () => {
		const harness = await createHarness({
			elicitationHandler: async () => ({
				action: "accept",
				content: { decision: "refine", feedback: "rework the tail" },
			}),
		});
		const { created, session } = await createPlanSession(harness);
		await session.planProposalHandler!("words-counter");
		expect(session.planModeState?.enabled).toBe(true);

		await harness.agent.closeSession({ sessionId: created.sessionId });
		const loaded = await harness.agent.loadSession({
			sessionId: created.sessionId,
			cwd: harness.cwd,
			mcpServers: [],
		});

		expect(loaded.modes?.currentModeId).toBe("plan");
		const meta = loaded._meta;
		const planMode =
			meta !== null && typeof meta === "object" && "omp.planMode" in meta ? meta["omp.planMode"] : undefined;
		expect(planMode !== null && typeof planMode === "object" && "active" in planMode && planMode["active"]).toBe(
			true,
		);
		expect(
			planMode !== null && typeof planMode === "object" && "planFilePath" in planMode && planMode["planFilePath"],
		).toBe("local://words-counter-plan.md");
		const planReview =
			meta !== null && typeof meta === "object" && "omp.planReview" in meta ? meta["omp.planReview"] : undefined;
		expect(
			planReview !== null && typeof planReview === "object" && "active" in planReview && planReview["active"],
		).toBe(true);
		const loadedSession = harness.findSession(created.sessionId)!;
		expect(loadedSession.planModeState?.enabled).toBe(true);
		expect(typeof loadedSession.planProposalHandler).toBe("function");
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("applies review decisions submitted through omp.planReview/action with streamed events", async () => {
		const harness = await createHarness({
			elicitationHandler: async () => ({ action: "accept", content: { decision: "refine" } }),
		});
		const { created, session, planUrl } = await createPlanSession(harness);
		await session.planProposalHandler!("words-counter");
		expect(session.planModeState?.enabled).toBe(true);
		const capturedReviewId = reviewUpdates(harness.updates).at(-2)?.review?.reviewId;

		// A stale review id cannot consume the pending review.
		const stale = await harness.agent.extMethod("omp.planReview/action", {
			sessionId: created.sessionId,
			reviewId: "not-the-review",
			decision: "keep",
		});
		expect(stale).toEqual({ ok: false, error: "No pending plan review matches the supplied review id." });

		const updatesBefore = harness.updates.length;
		const applied = await harness.agent.extMethod("omp.planReview/action", {
			sessionId: created.sessionId,
			reviewId: capturedReviewId,
			decision: "keep",
		});
		expect(applied).toEqual({ ok: true });
		expect(session.planModeState).toBeUndefined();
		expect(session.planReferencePath).toBe(planUrl);
		const approvedPrompt = session.promptCalls.join("\n");
		expect(approvedPrompt).toContain("Plan approved.");
		expect(reviewUpdates(harness.updates.slice(updatesBefore)).some(update => update.review === null)).toBe(true);
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("exiting plan mode consumes the pending review so it cannot be reopened", async () => {
		const harness = await createHarness({
			elicitationHandler: async () => ({ action: "accept", content: { decision: "refine" } }),
		});
		const { created, session } = await createPlanSession(harness);
		await session.planProposalHandler!("words-counter");

		await harness.agent.setSessionMode({ sessionId: created.sessionId, modeId: "default" });
		expect(session.planModeState).toBeUndefined();
		const reopen = await harness.agent.extMethod("omp.planReview/reopen", { sessionId: created.sessionId });
		expect(reopen).toEqual({ ok: false, error: "No pending plan review for this session." });
		harness.abortController.abort();
		await Bun.sleep(0);
	});

	it("serves /plan-review in text mode to reopen the pending review", async () => {
		const harness = await createHarness({
			elicitationHandler: async () => ({ action: "accept", content: { decision: "refine" } }),
		});
		const { created, session } = await createPlanSession(harness);
		await session.planProposalHandler!("words-counter");

		const updatesBefore = harness.updates.length;
		await harness.agent.prompt({
			sessionId: created.sessionId,
			prompt: [{ type: "text", text: "/plan-review" }],
		});

		const after = harness.updates.slice(updatesBefore);
		expect(reviewUpdates(after).some(update => update.review?.planFilePath === "local://words-counter-plan.md")).toBe(
			true,
		);
		const chunkTexts = after.flatMap(notification =>
			notification.update.sessionUpdate === "agent_message_chunk" && notification.update.content.type === "text"
				? [notification.update.content.text]
				: [],
		);
		expect(chunkTexts.some(text => text.includes("reopened"))).toBe(true);
		harness.abortController.abort();
		await Bun.sleep(0);
	});
});
