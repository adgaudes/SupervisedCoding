// End-to-end tests of the real extension against fake Claude Code and Pi CLIs, a fake Pi host and real Git repositories.
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
		piCommand: process.execPath,
		piCommandArgs: [path.join(here, "fakes", "fake-pi.mjs")],
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
	// Hand back the path Git reports, not the one just created: the extension compares the Git root with cwd and
	// with the authorized paths as text, and Git answers with the real, long-form path. A temp root that is an 8.3
	// short name (the Windows CI runners) or a symlink (/tmp on macOS) would otherwise make the two differ, and the
	// walk from the root down to an authorized path would stop before reaching any nested AGENTS.md.
	return path.resolve(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: repo, encoding: "utf8" }).trim());
}

/**
 * The learning key of a repository, normalized exactly as the extension's repoKey does: the Git root with forward
 * slashes, case-folded only on Windows. Lower-casing it everywhere hid the seeded outcomes on Linux and macOS, where
 * paths are case-sensitive, so this only ever worked on Windows.
 */
function learningRepoKey(repo: string): string {
	const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: repo, encoding: "utf8" }).trim();
	const normalized = path.resolve(root).replace(/\\/g, "/");
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
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
		"anthropic/claude-opus-5-5": { provider: "anthropic", id: "claude-opus-5-5", name: "Claude Opus 5.5" },
		"openai-codex/gpt-5.5": { provider: "openai-codex", id: "gpt-5.5", name: "GPT-5.5" },
		"openai-codex/gpt-6-sol": { provider: "openai-codex", id: "gpt-6-sol", name: "GPT-6 Sol" },
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
	assert.equal(result.details.verification, "unchanged_failures");
	assert.equal(result.details.correctionRounds, 0);
	assert.match(result.content[0].text, /was already failing before this task/);
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
	const repo = makeRepo({ "value.txt": "ok", "value.test.mjs": PASSING_CHECK });
	const poor = { evidenceVersion: 2, taskKind: "general", at: Date.now(), repo: learningRepoKey(repo), taskId: "seed", profile: "medium", worker: "claude", model: "claude-sonnet-5", effort: "high", verification: "failed", correctionRounds: 2, review: "none", failed: true, tokens: 0, costUsd: 0 };
	fs.writeFileSync(dataFile, JSON.stringify({ version: 1, outcomes: [0,1,2].map(i => ({...poor, taskId: "seed-" + i})), lessons: [], effortAdjustments: {} }));
	configure({ maxCorrectionRounds: 0 }, { "claude-sonnet-5": [{ write: { "value.txt": "broken" } }, { write: { "other.txt": "x\n" } }] });
	const host = makeHost(repo);
	await host.on();
	const first = await host.call("delegate_implementation", { task: "Change value.txt", profile: "medium", implementationGuide: guide(["value.txt"], ["node --test"]), allowedPaths: ["value.txt"] });
	assert.equal(calls()[0].effort, "high");
	assert.match(first.content[0].text, /Learning: medium\/claude-sonnet-5: effort high → xhigh/);
	await host.call("delegate_implementation", { task: "Write other.txt", profile: "medium", implementationGuide: guide(["other.txt"]), allowedPaths: ["other.txt"] });
	assert.equal(calls()[1].effort, "xhigh", "the next delegation uses the calibrated effort");
});

test("critical review goes to the API reviewer with diff and files, without a CLI reviewer", async () => {
	configure(
		{ independentReviewProfiles: ["critical"], reviewApi: { provider: "openai-codex", model: "gpt-5.5", reasoning: "high" }, workerChains: { ...baseConfig.workerChains, critical: [{ worker: "claude", model: "fake-opus", effort: "xhigh" }, { worker: "pi", provider: "openai-codex", model: "gpt-5.5", effort: "xhigh" }] } },
		{ "fake-opus": [{ write: { "core.txt": "critical change\n" } }] },
	);
	const host = makeHost(makeRepo({ "core.txt": "before\n" }));
	host.setApiReply("One edge case missing.\nVERDICT: MAJOR");
	await host.on();
	const result = await host.call("delegate_implementation", { task: "Change core.txt", profile: "critical", implementationGuide: guide(["core.txt"]), allowedPaths: ["core.txt"] });
	assert.equal(host.apiCalls.length, 1);
	assert.match(host.apiCalls[0].content, /\+critical change/);
	assert.match(host.apiCalls[0].content, /=== core\.txt ===\ncritical change/);
	assert.equal(calls().filter((item) => item.cli === "pi").length, 0, "no CLI reviewer call");
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
	await assert.rejects(host.call("delegate_implementation", { task: "Other", continuePrevious: true, implementationGuide: guide(["step3.txt"]), allowedPaths: ["step3.txt"] }), /no compatible previous worker session|different task/);
});

test("flagship workers run only after Yes; No falls back to the strongest non-flagship model", async () => {
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
	assert.match(host.questions[0], /^fake-fable would be more useful for this task\. Use it\?$/);
	await host.call("delegate_implementation", { task: "A again", implementationGuide: guide(["o.txt"]), allowedPaths: ["o.txt"] });
	assert.equal(host.questions.length, 1, "the answer holds for the whole task");

	fs.writeFileSync(logFile, "");
	await host.call("plan_task", { task: "Critical B", profile: "critical", rationale: "test" });
	host.setAnswer("Yes");
	await host.call("delegate_implementation", { task: "B", implementationGuide: guide(["f.txt"]), allowedPaths: ["f.txt"] });
	assert.deepEqual(calls().map((item) => item.model), ["fake-fable"]);
});

test("supervisor out of credits: switch to the next model and continue the run", async () => {
	configure({ supervisorChain: [{ provider: "openai-codex", model: "gpt-5.5" }, { provider: "anthropic", model: "claude-opus-5-5" }] }, {});
	const host = makeHost(makeRepo({}));
	host.ctx.model = { provider: "openai-codex", id: "gpt-5.5", name: "GPT-5.5" };
	await host.on();
	assert.equal(host.ctx.model.id, "gpt-5.5");
	const settle = host.handlers.get("agent_before_settle");
	const result = await settle({ outcome: "error", context: { contextMessages: [{ role: "assistant", stopReason: "error", errorMessage: "Codex error: The usage limit has been reached", provider: "openai-codex", model: "gpt-5.5" }] } }, host.ctx);
	assert.equal(host.ctx.model.id, "claude-opus-5-5");
	assert.equal(result.continue, true);
	assert.match(result.entries[0].content, /\[SUPERVISOR FAILOVER\]/);
	// A coding error is not a provider failure: no switch.
	const none = await settle({ outcome: "error", context: { contextMessages: [{ role: "assistant", stopReason: "error", errorMessage: "tool failed: 3 tests failed", provider: "anthropic", model: "claude-opus-5-5" }] } }, host.ctx);
	assert.equal(none, undefined);
	assert.equal(host.ctx.model.id, "claude-opus-5-5");
});

test("a guide without SYMBOLS/PRESERVE is completed with safe defaults instead of costing a supervisor turn", async () => {
	configure({}, { "claude-sonnet-5": [{ write: { "x.txt": "x\n" } }] });
	const host = makeHost(makeRepo({ "x.txt": "old\n" }));
	await host.on();
	const lean = "FILE: x.txt\nCHANGES:\n- Replace the whole content of the file x.txt with one single line that contains only the letter x; this sentence deliberately pads the guide so that it passes the minimum length for the medium profile, which requires four hundred characters of structured guidance before any worker may start working on the requested change in this small test repository.\nVERIFY:\n- Read the file back.";
	const result = await host.call("delegate_implementation", { task: "Rewrite x.txt", profile: "medium", implementationGuide: lean, allowedPaths: ["x.txt"] });
	assert.equal(result.isError, false);
	assert.match(calls()[0].prompt, /PRESERVE:\n- Existing public API/);
	assert.match(result.content[0].text, /DIFF \(this delegation only\)[\s\S]*-old[\s\S]*\+x/, "the supervisor sees the diff without extra turns");
});

function commitAll(repo: string): void {
	execFileSync("git", ["add", "-A"], { cwd: repo, stdio: "pipe" });
	execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "change"], { cwd: repo, stdio: "pipe" });
}

test("review_changes reviews a branch without the supervisor reading its diff; a rejected MAJOR finding is set apart", async () => {
	configure({}, {
		"claude-opus-5-5": [{ text: "- [MAJOR] src/lib.ts:1 — callers pass one argument — keep the old signature\n- [MINOR] src/lib.ts:2 — magic number — name it\nRisk: no test for factor\nVERDICT: MAJOR" }],
		"gpt-5.5": [{ text: "#1 REJECTED — factor has a default, so one-argument callers still work" }],
	});
	const repo = makeRepo({ "src/lib.ts": "export function scale(value: number) {\n\treturn value * 2;\n}\n", "src/use.ts": "import { scale } from \"./lib.ts\";\nexport const doubled = scale(3);\n" });
	fs.writeFileSync(path.join(repo, "src/lib.ts"), "export function scale(value: number, factor = 2) {\n\treturn value * factor;\n}\n");
	commitAll(repo);
	const host = makeHost(repo);
	await host.on();
	const result = await host.call("review_changes", { base: "HEAD~1", focus: "Make the factor configurable" });
	assert.equal(result.isError, false, result.content[0].text);
	const [review, verification] = calls();
	assert.equal(review.model, "claude-opus-5-5");
	assert.equal(review.tools, "Read,Glob,Grep", "reviewers are read-only");
	assert.match(review.prompt, /Intent and focus: Make the factor configurable/);
	assert.match(review.prompt, /\+export function scale\(value: number, factor = 2\)/);
	assert.match(review.prompt, /USES OF THE DECLARATIONS THE CHANGE TOUCHES[\s\S]*src\/use\.ts/, "callers of the changed signature are given");
	assert.match(review.prompt, /- \[MAJOR\] path\/to\/file\.ext:LINE/, "reviewers are asked for one line per finding");
	assert.equal(verification.model, "gpt-5.5", "the other family verifies MAJOR findings");
	assert.match(verification.prompt, /CITED CODE[\s\S]*src\/lib\.ts:1-3/);
	const text = result.content[0].text;
	assert.match(text, /Verdict: MINOR/);
	assert.match(text, /\[MINOR\] src\/lib\.ts:2 — magic number/);
	assert.match(text, /Rejected by verification[\s\S]*callers pass one argument — keep the old signature — rejected: factor has a default/);
	assert.match(text, /Risks:\n- no test for factor/);
	assert.equal(result.details.verdict, "minor");
});

test("review_changes splits a large change into parts reviewed by alternating families, or asks for narrower paths", async () => {
	const plan = { "claude-opus-5-5": [{ text: "No findings.\nVERDICT: PASS" }], "gpt-5.5": [{ text: "No findings.\nVERDICT: PASS" }] };
	configure({ maxDiffBytes: 128, reviewConcurrency: 1 }, plan);
	const repo = makeRepo({ "front/app.ts": "export const a = 1;\n", "back/api.ts": "export const b = 1;\n" });
	fs.writeFileSync(path.join(repo, "front/app.ts"), "export const a = 2;\n");
	fs.writeFileSync(path.join(repo, "back/api.ts"), "export const b = 2;\n");
	const host = makeHost(repo);
	await host.on();
	const result = await host.call("review_changes", { base: "HEAD" });
	assert.equal(result.isError, false, result.content[0].text);
	assert.equal(result.details.parts, 2);
	const reviews = calls();
	assert.deepEqual(reviews.map((item) => item.model).sort(), ["claude-opus-5-5", "gpt-5.5"]);
	assert.ok(reviews.every((item) => /This is part [12] of 2/.test(item.prompt)));
	assert.match(result.content[0].text, /2 parts reviewed in parallel[\s\S]*Verdict: PASS/);
	configure({ maxDiffBytes: 128, reviewMaxShards: 1 }, plan);
	const narrow = makeHost(repo);
	await narrow.on();
	await assert.rejects(narrow.call("review_changes", { base: "HEAD" }), /too large for one review[\s\S]*- (back|front): 1 file/);
});

test("a later review of the same branch checks earlier findings and reviews only what changed since; rounds are bounded", async () => {
	const reply = { text: "- [MINOR] a.ts:1 — vague name — rename it\nVERDICT: MINOR" };
	configure({}, { "claude-opus-5-5": [reply, reply, reply, reply] });
	const repo = makeRepo({ "a.ts": "export const a = 1;\n", "b.ts": "export const b = 1;\n" });
	fs.writeFileSync(path.join(repo, "a.ts"), "export const a = 2;\n");
	fs.writeFileSync(path.join(repo, "b.ts"), "export const b = 2;\n");
	const host = makeHost(repo);
	await host.on();
	const first = await host.call("review_changes", { base: "HEAD" });
	assert.equal(first.details.reviewCount, 1);
	const unchanged = await host.call("review_changes", { base: "HEAD" });
	assert.match(unchanged.content[0].text, /No changes since review 1 of this branch; its findings stand:\n- \[MINOR\] a\.ts:1 — vague name/);
	assert.equal(calls().length, 1, "nothing to review: no model call");
	fs.writeFileSync(path.join(repo, "b.ts"), "export const b = 3;\n");
	const second = await host.call("review_changes", { base: "HEAD" });
	const followUp = calls()[1].prompt;
	assert.match(followUp, /was reviewed before, and these findings were reported:\n- \[MINOR\] a\.ts:1 — vague name/);
	assert.match(followUp, /-export const b = 2;\n\+export const b = 3;/, "only the change since the last review");
	assert.doesNotMatch(followUp, /export const a = 2/);
	assert.match(second.content[0].text, /^Follow-up review 2/);
	assert.doesNotMatch(second.content[0].text, /CONVERGENCE/);
	fs.writeFileSync(path.join(repo, "b.ts"), "export const b = 4;\n");
	const third = await host.call("review_changes", { base: "HEAD" });
	assert.match(third.content[0].text, /CONVERGENCE: this branch has now been reviewed 3 times/);
	const full = await host.call("review_changes", { base: "HEAD", full: true });
	assert.match(calls()[3].prompt, /Review the changes against HEAD[\s\S]*\+export const a = 2;[\s\S]*\+export const b = 4;/);
	assert.equal(full.details.followUp, false);
});

test("an audit larger than one consultant should hold is split by directory and merged into one verified list", async () => {
	configure({ auditShardBytes: 128, reviewConcurrency: 1 }, {
		"claude-opus-5-5": [{ text: "- [MAJOR] a/x.ts:1 — unchecked input — validate it\n- [MAJOR] a/x.ts:2 — NaN passes — reject it" }],
		"gpt-5.5": [{ text: "- [MINOR] b/y.ts:2 — duplicated logic — share it" }, { text: "#1 CONFIRMED — the input reaches the query unchecked\n#2 MINOR — only reachable from tests" }],
	});
	const body = (name: string) => `export function ${name}(input: string) {\n\treturn input;\n}\n// ${"padding ".repeat(20)}\n`;
	const host = makeHost(makeRepo({ "a/x.ts": body("x"), "b/y.ts": body("y"), "AGENTS.md": "Validate every external input.\n" }));
	await host.on();
	const result = await host.call("consult_readonly", { purpose: "audit", question: "Find input validation bugs", paths: ["a", "b"] });
	assert.equal(result.isError, false, result.content[0].text);
	assert.equal(result.details.parts, 2);
	const [first, second] = calls();
	assert.match(first.prompt, /Relevant paths:\n- a\n/);
	assert.doesNotMatch(first.prompt, /\n- b\n/, "each consultant holds only its part");
	assert.match(second.prompt, /Relevant paths:\n- b\n/);
	assert.match(first.prompt, /REPOSITORY RULES \(judge the code against them\)\n\[AGENTS\.md\]\nValidate every external input\./, "consultants judge against the repository rules");
	const text = result.content[0].text;
	assert.match(text, /Findings \(1 MAJOR, 2 MINOR\)/);
	assert.match(text, /- \[MAJOR\] \(confirmed\) a\/x\.ts:1 — unchecked input/);
	assert.match(text, /- \[MINOR\] \(downgraded\) a\/x\.ts:2 — NaN passes/, "a real but immaterial finding is downgraded by the verifier");
	assert.match(text, /- \[MINOR\] b\/y\.ts:2 — duplicated logic/);
});

test("a fresh worker gets a code map of large authorized files: outline ranges and uses of the named symbols", async () => {
	configure({}, { "claude-sonnet-5": [{ write: { "big.ts": "changed\n" } }] });
	const filler = Array.from({ length: 260 }, (_, index) => `\tstep(${index});`).join("\n");
	const big = `export function alpha() {\n${filler}\n}\n\nexport function beta() {\n${filler}\n}\n`;
	const host = makeHost(makeRepo({ "big.ts": big, "caller.ts": "import { beta } from \"./big.ts\";\nbeta();\n", "small.ts": "export const s = 1;\n" }));
	await host.on();
	const withSymbol = guide(["big.ts", "small.ts"]).replace("SYMBOLS: none (plain files used by the integration test)", "SYMBOLS: beta, the second function of big.ts (alpha stays untouched)");
	await host.call("delegate_implementation", { task: "Change beta", profile: "medium", implementationGuide: withSymbol, allowedPaths: ["big.ts", "small.ts"] });
	const prompt = calls()[0].prompt;
	assert.match(prompt, /CODE MAP[\s\S]*big\.ts \(525 lines\)[\s\S]*264-525\s+export function beta\(\)/);
	assert.match(prompt, /Uses of the declarations named in the guide[\s\S]*caller\.ts/);
	assert.doesNotMatch(prompt, /small\.ts \(/, "small files are read whole: no map");
});

test("above reviewWholeFilesBytes the API reviewer gets the code around the change and outlines, not whole large files", async () => {
	const fn = (name: string, marker: string) => `export function ${name}() {\n${Array.from({ length: 100 }, (_, index) => `\tstep("${marker}-${index}");`).join("\n")}\n}\n`;
	const before = ["one", "two", "three", "four", "five"].map((name) => fn(name, name)).join("\n");
	const after = before.replace('step("three-50");', 'step("three-50-changed");');
	configure(
		{ independentReviewProfiles: ["critical"], reviewWholeFilesBytes: 1000, reviewApi: { provider: "openai-codex", model: "gpt-5.5", reasoning: "high" }, workerChains: { ...baseConfig.workerChains, critical: [{ worker: "claude", model: "fake-opus", effort: "xhigh" }, { worker: "pi", provider: "openai-codex", model: "gpt-5.5", effort: "xhigh" }] } },
		{ "fake-opus": [{ write: { "big.ts": after } }] },
	);
	const host = makeHost(makeRepo({ "big.ts": before }));
	await host.on();
	const result = await host.call("delegate_implementation", { task: "Change three", profile: "critical", implementationGuide: guide(["big.ts"]), allowedPaths: ["big.ts"] });
	assert.equal(host.apiCalls.length, 1, result.content[0].text);
	const content = host.apiCalls[0].content;
	assert.match(content, /CODE AROUND THE CHANGES[\s\S]*big\.ts:207-308\n207\| export function three\(\)/, "the whole changed function");
	assert.match(content, /three: no references/, "uses exclude the changed declaration's own body");
	assert.match(content, /=== big\.ts \(outline only: \d+ lines/);
	assert.doesNotMatch(content, /step\("one-50"\)/, "code far from the change is not sent");
});

test("a guide describing the change on each FILE line is accepted without a CHANGES header", async () => {
	configure({}, { "claude-sonnet-5": [{ write: { "x.txt": "x\n" } }] });
	const host = makeHost(makeRepo({ "x.txt": "old\n" }));
	await host.on();
	const perFile = "FILE: x.txt: replace the whole content with one single line holding only the letter x, keeping the trailing newline; this guide is deliberately long enough to pass the minimum guide length of the medium profile, which asks for four hundred characters of structured guidance before any worker may start working on the requested change in this small test repository.\nPRESERVE: everything else.\nVERIFY: read the file back.";
	const result = await host.call("delegate_implementation", { task: "Rewrite x.txt", profile: "medium", implementationGuide: perFile, allowedPaths: ["x.txt"] });
	assert.equal(result.isError, false, result.content[0].text);
	await assert.rejects(host.call("delegate_implementation", { task: "Rewrite x.txt", profile: "medium", implementationGuide: `FILE: x.txt\n${"PRESERVE: everything else. ".repeat(20)}\nVERIFY: read it.`, allowedPaths: ["x.txt"] }), /missing required sections: CHANGE/);
});

test("a one-paragraph guide is split into sections, its VERIFY runs, and unnamed authorized paths are listed for the worker", async () => {
	configure({}, { "claude-sonnet-5": [{ write: { "value.txt": "ok", "extra.txt": "extra\n" } }] });
	const host = makeHost(makeRepo({ "value.txt": "ok", "value.test.mjs": PASSING_CHECK }));
	await host.on();
	const paragraph = "FILE: extra.txt. SYMBOLS: none, it is a plain text file created by this change. CHANGE/CHANGES: create extra.txt with a single line that says extra, and keep value.txt exactly as it is so that the existing test keeps passing; this sentence deliberately pads the guide beyond the medium minimum of four hundred characters of guidance. PRESERVE: value.txt, its test and every other file in the repository. VERIFY: node --test.";
	const result = await host.call("delegate_implementation", { task: "Add extra.txt", profile: "medium", implementationGuide: paragraph, allowedPaths: ["extra.txt", "notes.txt"] });
	assert.equal(result.isError, false, result.content[0].text);
	assert.equal(result.details.verification, "passed", "VERIFY: node --test. runs node --test");
	const prompt = calls()[0].prompt;
	assert.match(prompt, /FILE: extra\.txt\.\nSYMBOLS: none[\s\S]*\nCHANGE\/CHANGES: create[\s\S]*\nVERIFY: node --test\./);
	assert.match(prompt, /ALSO AUTHORIZED \(edit only if the change requires it\): notes\.txt/);
});

test("supervisor_git does not send again a diff the delegation result already showed whole", async () => {
	configure({}, { "claude-sonnet-5": [{ write: { "x.txt": "new\n" } }] });
	const repo = makeRepo({ "x.txt": "old\n" });
	const host = makeHost(repo);
	await host.on();
	await host.call("delegate_implementation", { task: "Rewrite x.txt", profile: "medium", implementationGuide: guide(["x.txt"]), allowedPaths: ["x.txt"] });
	const again = await host.call("supervisor_git", { action: "diff", paths: ["x.txt"], unifiedLines: 5 });
	assert.match(again.content[0].text, /No change since the delegation results of this task/);
	assert.equal(again.details.alreadyShown, true);
	const wider = await host.call("supervisor_git", { action: "diff", paths: ["x.txt"], unifiedLines: 20 });
	assert.match(wider.content[0].text, /\+new/, "more context is still available on request");
	// A later step of the same task on another file: both diffs were shown whole, by different results.
	configure({}, { "claude-sonnet-5": [{ write: { "y.txt": "why\n" } }] });
	await host.call("delegate_implementation", { task: "Add y.txt", profile: "medium", continuePrevious: true, implementationGuide: guide(["y.txt"]), allowedPaths: ["y.txt"] });
	assert.equal((await host.call("supervisor_git", { action: "diff" })).details.alreadyShown, true);
	fs.writeFileSync(path.join(repo, "x.txt"), "edited by hand\n");
	const changed = await host.call("supervisor_git", { action: "diff" });
	assert.match(changed.content[0].text, /\+edited by hand/, "a file that changed is diffed again");
	fs.writeFileSync(path.join(repo, "x.txt"), "new\n");
	assert.equal((await host.call("supervisor_git", { action: "diff", paths: ["x.txt"] })).details.alreadyShown, true);
	await host.call("complete_task", { decision: "accept", summary: "Reviewed both steps and their diffs." });
	const afterAccept = await host.call("supervisor_git", { action: "diff", paths: ["x.txt"] });
	assert.match(afterAccept.content[0].text, /\+new/, "once the task is accepted its results may be pruned: the diff is sent again");
});

test("a delegation diff over the result's diff budget is reported as incomplete, and supervisor_git still sends it", async () => {
	const big = Array.from({ length: 1800 }, (_, index) => `line ${index} ${"x".repeat(10)}`).join("\n");
	configure({}, { "claude-sonnet-5": [{ write: { "x.txt": `${big}\n` } }] });
	const host = makeHost(makeRepo({ "x.txt": "old\n" }));
	await host.on();
	const result = await host.call("delegate_implementation", { task: "Rewrite x.txt", profile: "medium", implementationGuide: guide(["x.txt"]), allowedPaths: ["x.txt"] });
	assert.match(result.content[0].text, /DIFF: incomplete; inspect with supervisor_git\. Changed paths: x\.txt\./);
	assert.doesNotMatch(result.content[0].text, /omitted to keep this result within maxOutputBytes/);
	const diff = await host.call("supervisor_git", { action: "diff", paths: ["x.txt"] });
	assert.match(diff.content[0].text, /\+line 1799/);
});

test("after an accepted task, the end of the run replaces its bulky tool results with short notes", async () => {
	configure({ contextPruning: { enabled: true, minResultBytes: 1500, minTotalBytes: 1000 } }, {});
	const host = makeHost(makeRepo({}));
	await host.on();
	const entry = (id: string, message: any) => ({ sourceEntry: { id, type: "message" }, messages: [message] });
	const contextEntries = [
		entry("u1", { role: "user", content: "fix it" }),
		entry("a1", { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "x.ts" } }] }),
		entry("t1", { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "x".repeat(6000) }] }),
		entry("t2", { role: "toolResult", toolCallId: "c2", toolName: "delegate_implementation", content: [{ type: "text", text: "done" }], details: { taskPacketId: "T" } }),
		entry("t3", { role: "toolResult", toolCallId: "c3", toolName: "complete_task", content: [{ type: "text", text: "Task accepted and completed." }], details: { taskId: "T", accepted: true } }),
	];
	const settle = host.handlers.get("agent_before_settle");
	const pruned = await settle({ outcome: "completed", context: { contextEntries } }, host.ctx);
	assert.deepEqual(pruned.entries.map((item: any) => [item.type, item.targetId]), [["context_edit", "t1"]]);
	assert.match(pruned.entries[0].replacement.content[0].text, /^\[pruned\] Read of x\.ts omitted after its task was accepted/);
	configure({ contextPruning: { enabled: false } }, {});
	const off = makeHost(makeRepo({}));
	await off.on();
	assert.equal(await off.handlers.get("agent_before_settle")({ outcome: "completed", context: { contextEntries } }, off.ctx), undefined);
});
