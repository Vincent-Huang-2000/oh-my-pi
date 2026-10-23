/**
 * Contract: ACP run modes (`omp.goalMode` v1, see docs/acp-run-modes.md).
 *
 * Real SDK sessions (goal tool, goal runtime, RPC goal controller) behind a real
 * `AcpAgent`; only the model is scripted. Each test names what an ACP client
 * observes if it regresses: a goal that never continues or never stops, a
 * stop that keeps running the goal, a mode exit that leaves the goal tool
 * behind, or a reload that silently resumes autonomous work.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ACP_BOOTSTRAP_RACE_GUARD_MS, AcpAgent } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-agent";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { cfgAsyncEnabled } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { getConfigRootDir, setAgentDir } from "@oh-my-pi/pi-utils";
import type { AgentSideConnection, SessionNotification, SessionUpdate } from "@oh-my-pi/pi-utils/acp";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

type Harness = {
	agent: AcpAgent;
	updates: SessionNotification[];
	sessions: AgentSession[];
	cwd: string;
	agentDir: string;
	/** Scripted model turns, consumed in order; a text-only reply once exhausted. */
	turns: MockResponse[];
	modelCalls: () => number;
	/** Messages the model received on call `index`. */
	modelMessages: (index: number) => unknown;
	newAgent: () => AcpAgent;
};

const cleanupRoots: string[] = [];
const cleanupSessions: AgentSession[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

afterEach(async () => {
	for (const session of cleanupSessions.splice(0)) {
		if (!session.isDisposed) await session.dispose();
	}
	AgentStorage.close();
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

async function createHarness(): Promise<Harness> {
	const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-acp-run-modes-"));
	cleanupRoots.push(root);
	const agentDir = path.join(root, "agent");
	const cwd = path.join(root, "cwd");
	await fs.promises.mkdir(agentDir, { recursive: true });
	await fs.promises.mkdir(cwd, { recursive: true });
	setAgentDir(agentDir);
	const settings = await Settings.init({ agentDir, cwd, inMemory: true });
	cfgAsyncEnabled.set(settings, false);
	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, path.join(root, "models.yml"));

	const turns: MockResponse[] = [];
	const mock = createMockModel({ handler: () => turns.shift() ?? { content: ["Nothing left to do."] } });
	const updates: SessionNotification[] = [];
	const sessions: AgentSession[] = [];
	const factory = async (sessionCwd: string) => {
		const { session } = await createAgentSession({
			cwd: sessionCwd,
			agentDir,
			sessionManager: SessionManager.create(sessionCwd),
			authStorage,
			modelRegistry,
			settings,
			model: getBundledModel("anthropic", "claude-sonnet-4-5"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			workspaceTree: { rootPath: sessionCwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});
		session.agent.streamFn = mock.stream;
		sessions.push(session);
		cleanupSessions.push(session);
		return session;
	};
	const newAgent = () => {
		const connection = {
			sessionUpdate: async (notification: SessionNotification) => {
				updates.push(notification);
			},
			signal: new AbortController().signal,
			closed: Promise.withResolvers<void>().promise,
		} as unknown as AgentSideConnection;
		return new AcpAgent(connection, factory);
	};
	return {
		agent: newAgent(),
		updates,
		sessions,
		cwd,
		agentDir,
		turns,
		modelCalls: () => mock.calls.length,
		modelMessages: index => mock.calls[index]?.context.messages,
		newAgent,
	};
}

/** A session past the bootstrap race guard, so run-mode updates are pushed. */
async function startSession(harness: Harness): Promise<{ sessionId: string; session: AgentSession }> {
	const created = await harness.agent.newSession({ cwd: harness.cwd, mcpServers: [] });
	await Bun.sleep(ACP_BOOTSTRAP_RACE_GUARD_MS + 20);
	const session = harness.sessions.find(candidate => candidate.sessionId === created.sessionId);
	if (!session) throw new Error("session was not created");
	return { sessionId: created.sessionId, session };
}

function updatesOf<K extends SessionUpdate["sessionUpdate"]>(
	harness: Harness,
	sessionId: string,
	kind: K,
): Array<SessionUpdate & { sessionUpdate: K }> {
	return harness.updates
		.filter(notification => notification.sessionId === sessionId && notification.update.sessionUpdate === kind)
		.map(notification => notification.update as SessionUpdate & { sessionUpdate: K });
}

function text(value: string) {
	return [{ type: "text" as const, text: value }];
}

const COMPLETE_GOAL: MockResponse = {
	content: [{ type: "toolCall", id: "complete", name: "goal", arguments: { op: "complete" } }],
};

describe("ACP goal mode", () => {
	it("takes the next prompt as the objective and keeps the prompt open until the goal completes", async () => {
		const harness = await createHarness();
		const { sessionId, session } = await startSession(harness);
		harness.turns.push({ content: ["Step one done."] }, COMPLETE_GOAL, { content: ["Goal complete."] });

		await harness.agent.setSessionMode({ sessionId, modeId: "goal" });
		expect(updatesOf(harness, sessionId, "goal_update").at(-1)).toMatchObject({ goal: null, armed: "objective" });

		const response = await harness.agent.prompt({ sessionId, prompt: text("ship the feature") });

		// The objective turn, the continuation, and its post-tool reply all ran in one prompt.
		expect(response.stopReason).toBe("end_turn");
		expect(harness.modelCalls()).toBe(3);
		const goalUpdates = updatesOf(harness, sessionId, "goal_update");
		expect(goalUpdates.some(update => update.goal?.objective === "ship the feature")).toBe(true);
		expect(goalUpdates.at(-1)).toEqual({ sessionUpdate: "goal_update", goal: null, armed: null });
		expect(updatesOf(harness, sessionId, "current_mode_update").at(-1)?.currentModeId).toBe("default");
		expect(session.getEnabledToolNames()).not.toContain("goal");
		expect(
			session.sessionManager
				.getEntries()
				.some(entry => entry.type === "custom" && entry.customType === "goal-completed"),
		).toBe(true);
	});

	it("stops continuing after a turn without progress and leaves the goal active", async () => {
		const harness = await createHarness();
		const { sessionId, session } = await startSession(harness);

		const response = await harness.agent.prompt({ sessionId, prompt: text("/goal keep polishing") });

		// Objective turn plus one text-only continuation; the empty activity stops the loop.
		expect(response.stopReason).toBe("end_turn");
		expect(harness.modelCalls()).toBe(2);
		expect(session.getGoalModeState()).toMatchObject({ enabled: true, goal: { status: "active" } });
		expect(session.getEnabledToolNames()).toContain("goal");
	});

	it("pauses the goal on cancel instead of continuing it", async () => {
		const harness = await createHarness();
		const { sessionId, session } = await startSession(harness);
		harness.turns.push({ content: ["Working on it."], delayMs: 10_000 });

		const pending = harness.agent.prompt({ sessionId, prompt: text("/goal refactor the parser") });
		while (!session.isStreaming) await Bun.sleep(10);
		await harness.agent.cancel({ sessionId });
		const response = await pending;

		expect(response.stopReason).toBe("cancelled");
		expect(session.getGoalModeState()?.goal.status).toBe("paused");
		await session.waitForIdle();
		await Bun.sleep(50);
		// No goal turn ran after the stop.
		expect(
			session.sessionManager
				.getEntries()
				.some(entry => entry.type === "custom_message" && entry.customType === "goal-continuation"),
		).toBe(false);
		expect(updatesOf(harness, sessionId, "goal_update").at(-1)?.goal?.status).toBe("paused");
	});

	it("drops the goal and restores the tool set when the client leaves goal mode", async () => {
		const harness = await createHarness();
		const { sessionId, session } = await startSession(harness);
		const toolsBefore = session.getEnabledToolNames();
		await harness.agent.prompt({ sessionId, prompt: text("/goal tidy the docs") });
		expect(session.getEnabledToolNames()).toContain("goal");

		const response = await harness.agent.setSessionMode({ sessionId, modeId: "default" });

		expect(session.getGoalModeState()).toBeUndefined();
		expect(session.getEnabledToolNames()).toEqual(toolsBefore);
		expect(response._meta?.["omp.goalMode"]).toEqual({ version: 1, active: false, goal: null, armed: null });
		expect(updatesOf(harness, sessionId, "goal_update").at(-1)).toMatchObject({ goal: null, armed: null });
		expect(session.sessionManager.buildSessionContext().mode).toBe("none");
	});

	it("reloads an active goal as paused, in goal mode", async () => {
		const harness = await createHarness();
		const { sessionId, session } = await startSession(harness);
		await harness.agent.prompt({ sessionId, prompt: text("/goal migrate the config") });
		expect(session.getGoalModeState()?.enabled).toBe(true);
		await session.sessionManager.flush();

		const reloaded = await harness.newAgent().loadSession({ sessionId, cwd: harness.cwd, mcpServers: [] });

		expect(reloaded.modes?.currentModeId).toBe("goal");
		expect(reloaded._meta?.["omp.goalMode"]).toMatchObject({
			active: true,
			goal: { objective: "migrate the config", status: "paused" },
		});
	});

	it("runs the guided interview with the goal tool, then enters goal mode when the agent creates the goal", async () => {
		const harness = await createHarness();
		const { sessionId, session } = await startSession(harness);
		harness.turns.push(
			{ content: ["What does done look like?"] },
			{
				content: [
					{
						type: "toolCall",
						id: "create",
						name: "goal",
						arguments: { op: "create", objective: "## Objective\nShip docs" },
					},
				],
			},
			{ content: ["Goal set."] },
		);

		await harness.agent.prompt({ sessionId, prompt: text("/guided-goal ship docs") });

		// The rough idea reaches the model as interview data; no goal exists yet.
		expect(JSON.stringify(harness.modelMessages(0))).toContain("ship docs");
		expect(session.getEnabledToolNames()).toContain("goal");
		expect(session.getGoalModeState()).toBeUndefined();
		expect(updatesOf(harness, sessionId, "goal_update").at(-1)).toMatchObject({ goal: null, armed: "interview" });
		expect(updatesOf(harness, sessionId, "current_mode_update").at(-1)?.currentModeId).toBe("goal");

		await harness.agent.prompt({ sessionId, prompt: text("All docs pages build.") });

		expect(session.getGoalModeState()?.goal.objective).toBe("## Objective\nShip docs");
		expect(updatesOf(harness, sessionId, "goal_update").at(-1)).toMatchObject({
			goal: { status: "active" },
			armed: null,
		});
	});

	it("advertises goal mode and goal commands to ACP clients", async () => {
		const harness = await createHarness();
		const { sessionId } = await startSession(harness);
		// Bootstrap advertises commands after discovering file commands.
		for (
			let attempt = 0;
			attempt < 100 && !updatesOf(harness, sessionId, "available_commands_update").length;
			attempt++
		) {
			await Bun.sleep(20);
		}
		const commands = updatesOf(harness, sessionId, "available_commands_update").at(-1)?.availableCommands ?? [];
		expect(commands.map(command => command.name)).toEqual(expect.arrayContaining(["goal", "guided-goal"]));
		const response = await harness.agent.setSessionMode({ sessionId, modeId: "goal" });
		expect(response._meta?.["omp.goalMode"]).toEqual({ version: 1, active: true, goal: null, armed: "objective" });
	});
});

describe("ACP vibe mode", () => {
	it("swaps in the director tool set and restores the previous tools on exit", async () => {
		const harness = await createHarness();
		const { sessionId, session } = await startSession(harness);
		const toolsBefore = session.getEnabledToolNames();
		expect(toolsBefore).toContain("edit");

		const entered = await harness.agent.setSessionMode({ sessionId, modeId: "vibe" });

		expect(entered._meta?.["omp.vibeMode"]).toEqual({ version: 1, active: true });
		const directorTools = session.getEnabledToolNames();
		expect(directorTools).toEqual(expect.arrayContaining(["read", "vibe_spawn", "vibe_send", "vibe_wait"]));
		expect(directorTools).not.toContain("edit");
		expect(session.sessionManager.buildSessionContext().mode).toBe("vibe");

		const exited = await harness.agent.setSessionMode({ sessionId, modeId: "default" });

		expect(exited._meta?.["omp.vibeMode"]).toEqual({ version: 1, active: false });
		expect(session.getEnabledToolNames()).toEqual(toolsBefore);
		expect(session.sessionManager.buildSessionContext().mode).toBe("none");
	});

	it("keeps the prompt open until a running worker turn's result reaches the director", async () => {
		const harness = await createHarness();
		const { sessionId, session } = await startSession(harness);
		await harness.agent.setSessionMode({ sessionId, modeId: "vibe" });
		const manager = session.asyncJobManager!;
		const workerDone = Promise.withResolvers<void>();
		manager.register(
			"task",
			"vibe fast w1",
			async () => {
				await workerDone.promise;
				return "worker finished the migration";
			},
			{ agentId: "w1", ownerId: session.getAgentId() },
		);
		harness.turns.push({ content: ["Waiting on the worker."] }, { content: ["The worker is done."] });

		let settled = false;
		const pending = harness.agent.prompt({ sessionId, prompt: text("check the worker") });
		void pending.then(() => {
			settled = true;
		});
		while (harness.modelCalls() < 1) await Bun.sleep(10);
		await session.waitForIdle();
		await Bun.sleep(50);
		expect(settled).toBe(false);

		workerDone.resolve();
		const response = await pending;

		expect(response.stopReason).toBe("end_turn");
		expect(harness.modelCalls()).toBe(2);
		expect(JSON.stringify(harness.modelMessages(1))).toContain("worker finished the migration");
	});

	it("ends the worker wait on cancel and leaves the worker running", async () => {
		const harness = await createHarness();
		const { sessionId, session } = await startSession(harness);
		await harness.agent.setSessionMode({ sessionId, modeId: "vibe" });
		const manager = session.asyncJobManager!;
		const workerDone = Promise.withResolvers<void>();
		const jobId = manager.register(
			"task",
			"vibe fast w1",
			async () => {
				await workerDone.promise;
				return "late result";
			},
			{ agentId: "w1", ownerId: session.getAgentId() },
		);

		const pending = harness.agent.prompt({ sessionId, prompt: text("start the work") });
		while (harness.modelCalls() < 1) await Bun.sleep(10);
		await session.waitForIdle();
		await harness.agent.cancel({ sessionId });

		expect((await pending).stopReason).toBe("cancelled");
		expect(manager.getJob(jobId)?.status).toBe("running");
		workerDone.resolve();
	});

	it("lets a new prompt interrupt the worker wait instead of queueing behind it", async () => {
		const harness = await createHarness();
		const { sessionId, session } = await startSession(harness);
		await harness.agent.setSessionMode({ sessionId, modeId: "vibe" });
		const workerDone = Promise.withResolvers<void>();
		session.asyncJobManager!.register(
			"task",
			"vibe fast w1",
			async () => {
				await workerDone.promise;
				return "late result";
			},
			{ agentId: "w1", ownerId: session.getAgentId() },
		);
		harness.turns.push({ content: ["Started the worker."] }, { content: ["Here is the status."] });

		const waiting = harness.agent.prompt({ sessionId, prompt: text("start the work") });
		while (harness.modelCalls() < 1) await Bun.sleep(10);
		await session.waitForIdle();
		const next = harness.agent.prompt({ sessionId, prompt: text("what is the status?") });

		// The new prompt runs while the worker is still busy.
		expect((await waiting).stopReason).toBe("cancelled");
		while (harness.modelCalls() < 2) await Bun.sleep(10);
		// It then waits for the worker itself, whose result wakes the director.
		workerDone.resolve();
		expect((await next).stopReason).toBe("end_turn");
		expect(harness.modelCalls()).toBe(3);
	});

	it("refuses /vibe while a goal occupies the mode slot", async () => {
		const harness = await createHarness();
		const { sessionId, session } = await startSession(harness);
		await harness.agent.prompt({ sessionId, prompt: text("/goal ship it") });

		await harness.agent.prompt({ sessionId, prompt: text("/vibe") });

		expect(session.getVibeModeState()).toBeUndefined();
		const output = updatesOf(harness, sessionId, "agent_message_chunk").at(-1);
		expect(output?.content).toEqual({ type: "text", text: "Exit goal mode first." });
	});
});
