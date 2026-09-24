// End-to-end tests of the real extension against fake Claude/Gemini CLIs, a fake Pi host and real Git repositories.
// Run with: node --import ./tests/resolve-pi.mjs --test tests/integration.test.ts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "supervised-coding-it-"));
const configFile = path.join(root, "config.json");
const dataFile = path.join(root, "data", "learning.json");
const planFile = path.join(root, "plan.json");
const logFile = path.join(root, "calls.jsonl");
process.env.SUPERVISED_CODING_CONFIG = configFile;
process.env.SUPERVISED_CODING_DATA = dataFile;
process.env.FAKE_PLAN = planFile;
process.env.FAKE_LOG = logFile;
// The checks run `node --test` themselves; nested under this test runner they would report to it and exit 0.
delete process.env.NODE_TEST_CONTEXT;
const { default: extension } = await import("../index.ts");
const baseConfig = JSON.parse(fs.readFileSync(path.join(here, "..", "config.json"), "utf8"));

after(() => fs.rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
	fs.rmSync(dataFile, { force: true });
	fs.writeFileSync(logFile, "");
});

type Step = { action?: string; write?: Record<string, string>; text?: string };

function configure(overrides: Record<string, unknown>, plan: Record<string, Step[]>): void {
	const config = {
		...baseConfig,
		workerCommand: process.execPath,
		workerCommandArgs: [path.join(here, "fakes", "fake-claude.mjs")],
		geminiCommand: process.execPath,
		geminiCommandArgs: [path.join(here, "fakes", "fake-gemini.mjs")],
		supervisorChain: [],
		probeOnActivate: false,
		flagshipModels: [],
		reviewApi: null,
		independentReviewProfiles: [],
		transientRetryDelayMs: 1,
		...overrides,
	};
	fs.writeFileSync(configFile, JSON.stringify(config));
	fs.writeFileSync(planFile, JSON.stringify(plan));
}

function calls(): Array<{ cli: string; model: string; effort?: string; resume?: string; mode?: string; tools?: string; prompt: string }> {
	return fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function makeRepo(files: Record<string, string>): string {
	const repo = fs.mkdtempSync(path.join(root, "repo-"));
	for (const [file, content] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
		fs.writeFileSync(path.join(repo, file), content);
	}
	const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
	git("init", "-q");
	git("add", "-A");
	git("-c", "user.email=t@t", "-c", "user.name=t", "-c", "core.autocrlf=false", "commit", "-q", "-m", "init", "--allow-empty");
	return repo;
}

function makeHost(repo: string) {
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const notifications: string[] = [];
	const questions: string[] = [];
	const handlers = new Map<string, any>();
	let answer = "No";
	const apiCalls: Array<{ model: string; content: string }> = [];
	let apiReply = "No material defect.\nVERDICT: PASS";
	let thinking = "medium";
	let activeTools = ["read", "bash", "edit", "write"];
	const models: Record<string, any> = {
		"google/gemini-3.1-pro-preview": { provider: "google", id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro" },
		"openai-codex/gpt-5.5": { provider: "openai-codex", id: "gpt-5.5", name: "GPT-5.5" },
		"google/gemini-3.8-flash": { provider: "google", id: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
	};
	const ctx: any = {
		cwd: repo,
		hasUI: true,
		model: { provider: "test", id: "supervisor" },
		modelRegistry: {
			find: (provider: string, id: string) => models[`${provider}/${id}`],
			hasConfiguredAuth: () => true,
			isUsingOAuth: (model: any) => model.provider === "openai-codex",
			streamSimple: (model: any, context: any) => ({
				result: async () => {
					apiCalls.push({ model: model.id, content: context.messages[0].content });
					return { role: "assistant", content: [{ type: "text", text: apiReply }], stopReason: "stop", usage: { input: 500, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 550, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.002 } } };
				},
			}),
		},
		ui: {
			notify: (text: string) => notifications.push(text),
			confirm: async () => true,
			select: async (title: string) => {
				questions.push(title);
				return answer;
			},
			setStatus: () => undefined,
			theme: { fg: (_: string, text: string) => text },
		},
		getContextUsage: () => undefined,
		sessionManager: { getBranch: () => [] },
	};
	const pi: any = {
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		on: (event: string, handler: any) => handlers.set(event, handler),
		appendEntry: () => undefined,
		getActiveTools: () => activeTools,
		setActiveTools: (names: string[]) => { activeTools = names; },
		setModel: async (model: any) => {
			ctx.model = model;
			return true;
		},
		getThinkingLevel: () => thinking,
		setThinkingLevel: (level: string) => { thinking = level; },
		sendMessage: () => undefined,
	};
	extension(pi);
	return {
		ctx,
		notifications,
		apiCalls,
		setApiReply: (text: string) => { apiReply = text; },
		setAnswer: (value: string) => { answer = value; },
		questions,
		handlers,
		on: () => commands.get("SupervisedCoding").handler("on", ctx),
		call: (name: string, params: any) => tools.get(name).execute("t", params, undefined, undefined, ctx),
	};
}

function guide(files: string[], verify: string[] = []): string {
	return [
		`FILE: ${files.join(", ")}`,
		"SYMBOLS: none (plain files used by the integration test)",
		"CHANGES:",
		"- Apply the scripted change; the fake worker writes the files itself.",
		"PRESERVE:",
		"- Everything outside the listed files; this guide is padded to exceed the minimum guide length required by the medium and larger profiles, which ask for four hundred characters of structured guidance before any worker may start.",
		"VERIFY:",
		...(verify.length ? verify.map((command) => `- \`${command}\``) : ["- Read the files back."]),
	].join("\n");
}

const PASSING_CHECK = `import test from "node:test";\nimport assert from "node:assert";\nimport fs from "node:fs";\ntest("value", () => assert.equal(fs.readFileSync("value.txt", "utf8"), "ok"));\n`;

test("independent review receives the actual diff and returns a verdict", async () => {
	configure(
		{ independentReviewProfiles: ["large"], workerChains: { ...baseConfig.workerChains, large: [{ worker: "claude", model: "fake-opus", effort: "high" }, { worker: "claude", model: "fake-sonnet", effort: "high" }] } },
		{ "fake-opus": [{ write: { "a.txt": "hello from the worker\n" } }], "fake-sonnet": [{ text: "Checked the change.\nVERDICT: MINOR" }] },
	);
	const host = makeHost(makeRepo({ "a.txt": "old\n" }));
	await host.on();
	const result = await host.call("delegate_implementation", { task: "Update a.txt", profile: "large", implementationGuide: guide(["a.txt"]), allowedPaths: ["a.txt"] });
	assert.equal(result.isError, false);
	const review = calls().find((item) => item.model === "fake-sonnet");
	assert.ok(review, "a different model reviews");
	assert.equal(review.tools, "Read,Glob,Grep", "the reviewer is read-only");
	assert.match(review.prompt, /CHANGES UNDER REVIEW/);
	assert.match(review.prompt, /\+hello from the worker/);
	assert.match(review.prompt, /-old/);
	assert.match(review.prompt, /VERDICT: PASS/);
	assert.equal(result.details.reviewVerdict, "minor");
});

test("a regression is fixed by the same worker session in a correction round", async () => {
	configure({}, {
		"claude-sonnet-5": [
			{ write: { "feature.txt": "feature\n", "value.txt": "broken" } },
			{ write: { "value.txt": "ok" }, text: "Restored value.txt." },
		],
	});
	const host = makeHost(makeRepo({ "value.txt": "ok", "value.test.mjs": PASSING_CHECK }));
	await host.on();
	const result = await host.call("delegate_implementation", { task: "Add feature.txt", profile: "medium", implementationGuide: guide(["feature.txt", "value.txt"], ["node --test"]), allowedPaths: ["feature.txt", "value.txt"] });
	assert.equal(result.isError, false, result.content[0].text);
	assert.equal(result.details.verification, "fixed");
	assert.equal(result.details.correctionRounds, 1);
	const [first, correction] = calls();
	assert.ok(correction.resume && first.resume === undefined, "the correction resumes the worker session");
	assert.match(correction.prompt, /\[CORRECTION ROUND 1\]/);
	assert.match(correction.prompt, /node --test/);
	assert.match(result.content[0].text, /AUTOMATIC VERIFICATION: FIXED/);
});

test("a check that was already failing is reported but not blamed on the worker", async () => {
	configure({}, { "claude-sonnet-5": [{ write: { "feature.txt": "feature\n" } }] });
	const broken = `import test from "node:test";\nimport assert from "node:assert";\ntest("always", () => assert.fail("pre-existing"));\n`;
	const host = makeHost(makeRepo({ "broken.test.mjs": broken }));
	await host.on();
	const result = await host.call("delegate_implementation", { task: "Add feature.txt", profile: "medium", implementationGuide: guide(["feature.txt"], ["node --test broken.test.mjs"]), allowedPaths: ["feature.txt"] });
	assert.equal(result.isError, false);
	assert.equal(result.details.verification, "passed");
	assert.equal(result.details.correctionRounds, 0);
	assert.match(result.content[0].text, /was already failing before the change/);
	assert.equal(calls().length, 1, "no correction round for a pre-existing failure");
});

test("an unfixable regression fails the delegation after the bounded rounds", async () => {
	configure({ maxCorrectionRounds: 1 }, {
		"claude-sonnet-5": [{ write: { "value.txt": "broken" } }, { write: { "value.txt": "still broken" } }],
	});
	const host = makeHost(makeRepo({ "value.txt": "ok", "value.test.mjs": PASSING_CHECK }));
	await host.on();
	const result = await host.call("delegate_implementation", { task: "Change value.txt", profile: "medium", implementationGuide: guide(["value.txt"], ["node --test"]), allowedPaths: ["value.txt"] });
	assert.equal(result.isError, true);
	assert.equal(result.details.verification, "failed");
	assert.equal(calls().length, 2);
});

test("failover hands the partial diff to the next worker", async () => {
	configure(
		{ workerChains: { ...baseConfig.workerChains, medium: [{ worker: "claude", model: "fake-a", effort: "high" }, { worker: "claude", model: "fake-b", effort: "high" }] } },
		{ "fake-a": [{ action: "credits", write: { "partial.txt": "half done\n" } }], "fake-b": [{ write: { "partial.txt": "complete\n" } }] },
	);
	const host = makeHost(makeRepo({}));
	await host.on();
	const result = await host.call("delegate_implementation", { task: "Write partial.txt", profile: "medium", implementationGuide: guide(["partial.txt"]), allowedPaths: ["partial.txt"] });
	assert.equal(result.isError, false);
	const second = calls()[1];
	assert.equal(second.model, "fake-b");
	assert.match(second.prompt, /\[HANDOFF\]/);
	assert.match(second.prompt, /\+half done/);
	// fake-a is now blocked for this model only: a second delegation skips it without a call.
	fs.writeFileSync(logFile, "");
	fs.writeFileSync(planFile, JSON.stringify({ "fake-b": [{ write: { "partial.txt": "again\n" } }] }));
	await host.call("delegate_implementation", { task: "Rewrite partial.txt", profile: "medium", implementationGuide: guide(["partial.txt"]), allowedPaths: ["partial.txt"] });
	assert.deepEqual(calls().map((item) => item.model), ["fake-b"]);
});

test("repository rules and recorded lessons reach every fresh worker", async () => {
	configure({}, { "claude-sonnet-5": [{ write: { "one.txt": "1\n" } }, { write: { "two.txt": "2\n" } }] });
	const host = makeHost(makeRepo({ "AGENTS.md": "Always use tabs for indentation.\n" }));
	await host.on();
	await host.call("delegate_implementation", { task: "Write one.txt", profile: "medium", implementationGuide: guide(["one.txt"]), allowedPaths: ["one.txt"] });
	assert.match(calls()[0].prompt, /REPOSITORY RULES[\s\S]*Always use tabs/);
	const lesson = await host.call("record_lesson", { lesson: "Run `npm run build` before `npm test`: the tests import from dist/." });
	assert.match(lesson.content[0].text, /Lesson recorded/);
	await host.call("plan_task", { task: "Next task", profile: "medium", rationale: "test" });
	await host.call("delegate_implementation", { task: "Write two.txt", profile: "medium", implementationGuide: guide(["two.txt"]), allowedPaths: ["two.txt"] });
	assert.match(calls()[1].prompt, /LESSONS FROM PREVIOUS WORK[\s\S]*npm run build/);
	const stored = JSON.parse(fs.readFileSync(dataFile, "utf8"));
	assert.equal(stored.lessons.length, 1);
	assert.equal(stored.outcomes.length, 2);
});

test("repeated poor outcomes raise the worker effort for that profile and model", async () => {
	fs.mkdirSync(path.dirname(dataFile), { recursive: true });
	const poor = { at: Date.now(), repo: "seed", taskId: "seed", profile: "medium", worker: "claude", model: "claude-sonnet-5", effort: "high", verification: "failed", correctionRounds: 2, review: "none", failed: true, tokens: 0, costUsd: 0 };
	fs.writeFileSync(dataFile, JSON.stringify({ version: 1, outcomes: [poor, poor, poor], lessons: [], effortAdjustments: {} }));
	configure({ maxCorrectionRounds: 0 }, { "claude-sonnet-5": [{ write: { "value.txt": "broken" } }, { write: { "other.txt": "x\n" } }] });
	const host = makeHost(makeRepo({ "value.txt": "ok", "value.test.mjs": PASSING_CHECK }));
	await host.on();
	const first = await host.call("delegate_implementation", { task: "Change value.txt", profile: "medium", implementationGuide: guide(["value.txt"], ["node --test"]), allowedPaths: ["value.txt"] });
	assert.equal(calls()[0].effort, "high");
	assert.match(first.content[0].text, /Learning: medium\/claude-sonnet-5: effort high → xhigh/);
	await host.call("delegate_implementation", { task: "Write other.txt", profile: "medium", implementationGuide: guide(["other.txt"]), allowedPaths: ["other.txt"] });
	assert.equal(calls()[1].effort, "xhigh", "the next delegation uses the calibrated effort");
});

test("critical review goes to the API reviewer with diff and files, without the Gemini CLI", async () => {
	configure(
		{ independentReviewProfiles: ["critical"], reviewApi: { provider: "google", model: "gemini-3.1-pro-preview", reasoning: "high" }, workerChains: { ...baseConfig.workerChains, critical: [{ worker: "claude", model: "fake-opus", effort: "xhigh" }, { worker: "gemini", model: "" }] } },
		{ "fake-opus": [{ write: { "core.txt": "critical change\n" } }] },
	);
	const host = makeHost(makeRepo({ "core.txt": "before\n" }));
	host.setApiReply("One edge case missing.\nVERDICT: MAJOR");
	await host.on();
	const result = await host.call("delegate_implementation", { task: "Change core.txt", profile: "critical", implementationGuide: guide(["core.txt"]), allowedPaths: ["core.txt"] });
	assert.equal(host.apiCalls.length, 1);
	assert.match(host.apiCalls[0].content, /\+critical change/);
	assert.match(host.apiCalls[0].content, /=== core\.txt ===\ncritical change/);
	assert.equal(calls().filter((item) => item.cli === "gemini").length, 0, "no Gemini CLI call");
	assert.equal(result.details.reviewVerdict, "major");
});

test("a follow-up step of the same task resumes the worker session on new paths", async () => {
	configure({}, { "claude-sonnet-5": [{ write: { "step1.txt": "1\n" } }, { write: { "step2.txt": "2\n" } }] });
	const host = makeHost(makeRepo({}));
	await host.on();
	await host.call("plan_task", { task: "Two-step task", profile: "medium", rationale: "test" });
	await host.call("delegate_implementation", { task: "Step 1", implementationGuide: guide(["step1.txt"]), allowedPaths: ["step1.txt"] });
	await host.call("delegate_implementation", { task: "Step 2", continuePrevious: true, implementationGuide: guide(["step2.txt"]), allowedPaths: ["step2.txt"] });
	const [first, second] = calls();
	assert.ok(first.resume === undefined && second.resume, "same task: session resumed despite the new path");
	await host.call("plan_task", { task: "Another task", profile: "medium", rationale: "test" });
	await assert.rejects(host.call("delegate_implementation", { task: "Other", continuePrevious: true, implementationGuide: guide(["step3.txt"]), allowedPaths: ["step3.txt"] }), /no compatible previous Claude session|different task/);
});

test("flagship workers run only after SI; No falls back to the strongest non-flagship model", async () => {
	configure(
		{ flagshipModels: ["fake-fable"], workerChains: { ...baseConfig.workerChains, critical: [{ worker: "claude", model: "fake-fable", effort: "xhigh" }, { worker: "claude", model: "fake-opus", effort: "xhigh" }] } },
		{ "fake-fable": [{ write: { "f.txt": "fable\n" } }], "fake-opus": [{ write: { "o.txt": "opus\n" } }] },
	);
	const host = makeHost(makeRepo({}));
	await host.on();
	await host.call("plan_task", { task: "Critical A", profile: "critical", rationale: "test" });
	host.setAnswer("No");
	await host.call("delegate_implementation", { task: "A", implementationGuide: guide(["o.txt"]), allowedPaths: ["o.txt"] });
	assert.deepEqual(calls().map((item) => item.model), ["fake-opus"], "declined flagship never starts");
	assert.equal(host.questions.length, 1);
	assert.match(host.questions[0], /^Sarebbe più utile utilizzare fake-fable per questa task\. Vuoi utilizzarlo\?$/);
	await host.call("delegate_implementation", { task: "A again", implementationGuide: guide(["o.txt"]), allowedPaths: ["o.txt"] });
	assert.equal(host.questions.length, 1, "the answer holds for the whole task");

	fs.writeFileSync(logFile, "");
	await host.call("plan_task", { task: "Critical B", profile: "critical", rationale: "test" });
	host.setAnswer("SI");
	await host.call("delegate_implementation", { task: "B", implementationGuide: guide(["f.txt"]), allowedPaths: ["f.txt"] });
	assert.deepEqual(calls().map((item) => item.model), ["fake-fable"]);
});

test("supervisor out of credits: switch to the next model and continue the run", async () => {
	configure({ supervisorChain: [{ provider: "openai-codex", model: "gpt-5.5" }, { provider: "google", model: "gemini-3.1-pro-preview" }] }, {});
	const host = makeHost(makeRepo({}));
	host.ctx.model = { provider: "openai-codex", id: "gpt-5.5", name: "GPT-5.5" };
	await host.on();
	assert.equal(host.ctx.model.id, "gpt-5.5");
	const settle = host.handlers.get("agent_before_settle");
	const result = await settle({ outcome: "error", context: { contextMessages: [{ role: "assistant", stopReason: "error", errorMessage: "Codex error: The usage limit has been reached", provider: "openai-codex", model: "gpt-5.5" }] } }, host.ctx);
	assert.equal(host.ctx.model.id, "gemini-3.1-pro-preview");
	assert.equal(result.continue, true);
	assert.match(result.entries[0].content, /\[SUPERVISOR FAILOVER\]/);
	// A coding error is not a provider failure: no switch.
	const none = await settle({ outcome: "error", context: { contextMessages: [{ role: "assistant", stopReason: "error", errorMessage: "tool failed: 3 tests failed", provider: "google", model: "gemini-3.1-pro-preview" }] } }, host.ctx);
	assert.equal(none, undefined);
	assert.equal(host.ctx.model.id, "gemini-3.1-pro-preview");
});

test("a guide without SYMBOLS/PRESERVE is completed with safe defaults instead of costing a supervisor turn", async () => {
	configure({}, { "claude-sonnet-5": [{ write: { "x.txt": "x\n" } }] });
	const host = makeHost(makeRepo({ "x.txt": "old\n" }));
	await host.on();
	const lean = "FILE: x.txt\nCHANGES:\n- Replace the whole content of the file x.txt with one single line that contains only the letter x; this sentence deliberately pads the guide so that it passes the minimum length for the medium profile, which requires four hundred characters of structured guidance before any worker may start working on the requested change in this small test repository.\nVERIFY:\n- Read the file back.";
	const result = await host.call("delegate_implementation", { task: "Rewrite x.txt", profile: "medium", implementationGuide: lean, allowedPaths: ["x.txt"] });
	assert.equal(result.isError, false);
	assert.match(calls()[0].prompt, /PRESERVE:\n- Existing public API/);
	assert.match(result.content[0].text, /DIFF \(allowed paths vs HEAD\)[\s\S]*-old[\s\S]*\+x/, "the supervisor sees the diff without extra turns");
});
