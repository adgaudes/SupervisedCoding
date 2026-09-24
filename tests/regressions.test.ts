// End-to-end tests of the real extension against fake Claude/Gemini CLIs, a fake Pi host and real Git repositories.
// Regression tests derived from the audit: assert the repaired guarantees.
// Run: node --import ./tests/resolve-pi.mjs --test tests/regressions.test.ts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "tests");
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

function calls(): Array<{ cli: string; model: string; effort?: string; maxTurns?: string; resume?: string; mode?: string; tools?: string; prompt: string }> {
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
		appendEntry: (_type: string, data: any) => { ctx.auditState = structuredClone(data); },
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
		command: (args: string) => commands.get("SupervisedCoding").handler(args, ctx), notifications,
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

import { emptyLearning, recordOutcome, tuneEfforts, effectiveEffort } from "../learning.ts";

test("AUDIT: effort changes require new evidence, including return to an earlier level", () => {
  const state = emptyLearning();
  const target = { profile: "medium", model: "m", configured: "high" as const };
  for (let i=0;i<4;i++) recordOutcome(state, {at:1,repo:"r",taskId:"t",profile:"medium",worker:"claude",model:"m",effort:"high",verification:"failed",correctionRounds:0,review:"none",failed:true,tokens:0,costUsd:0});
  tuneEfforts(state,[target],undefined,2);
  for (let i=0;i<20;i++) recordOutcome(state, {at:3,repo:"r",taskId:"t",profile:"medium",worker:"claude",model:"m",effort:"xhigh",verification:"passed",correctionRounds:0,review:"none",failed:false,tokens:0,costUsd:0});
  tuneEfforts(state,[target],undefined,4);
  assert.equal(effectiveEffort(state,"medium","m","high"),"high");
  assert.equal(tuneEfforts(state,[target],undefined,5).length,0);
  assert.equal(effectiveEffort(state,"medium","m","high"),"high");
  assert.equal(tuneEfforts(state,[target],undefined,6).length,0);
  assert.equal(effectiveEffort(state,"medium","m","high"),"high");
});

test("AUDIT: a still failing baseline never counts as first-pass test success", async () => {
  configure({}, {"claude-sonnet-5":[{write:{"value.txt":"bad"}}]});
  const host=makeHost(makeRepo({"value.txt":"bad","check.test.mjs":PASSING_CHECK})); await host.on();
  const result=await host.call("delegate_implementation", {task:"change",profile:"medium",allowedPaths:["value.txt"],implementationGuide:guide(["value.txt"],["node --test check.test.mjs"])});
  const learned=JSON.parse(fs.readFileSync(dataFile,"utf8"));
  assert.equal(result.details.verification,"unchanged_failures"); assert.equal(learned.outcomes.at(-1).verification,"unchanged_failures");
  assert.match(result.content[0].text,/already failing/);
});

test("AUDIT: explicit acceptance closes a critical task and resets effort", async () => {
  configure({}, {"claude-fable-5-1":[{write:{"a.txt":"done"}}]});
  const host=makeHost(makeRepo({"a.txt":"old"})); await host.on();
  await host.call("delegate_implementation",{task:"change",profile:"critical",allowedPaths:["a.txt"],implementationGuide:guide(["a.txt"])});
  await host.call("complete_task",{decision:"accept",summary:"Reviewed the final change and its requirements."});
  await host.handlers.get("agent_settled")({},host.ctx);
  await host.handlers.get("before_agent_start")({prompt:"A new request"},host.ctx);
  await host.command("status");
  assert.equal(host.ctx.auditState.taskPacket.phase,"completed");
  assert.match(host.notifications.at(-1)!, /effort medium/);
});

test("AUDIT: activation never probes an unapproved flagship", async () => {
  configure({supervisorChain:[{provider:"openai-codex",model:"gpt-5.5"}],flagshipModels:["gpt-5.5"],probeOnActivate:true}, {});
  const host=makeHost(makeRepo({"a.txt":"old"})); let probes=0;
  host.ctx.modelRegistry.complete=async()=>{probes++; return {stopReason:"stop",usage:{totalTokens:999}};};
  await host.on();
  assert.equal(probes,0); assert.equal(host.questions.length,0);
  assert.equal(Object.keys(host.ctx.auditState.metrics.byModel).some(k=>k.includes("gpt-5.5")),false);
});

test("AUDIT: account exhaustion skips subsequent models on the same account", async () => {
  const fake=path.join(root,"account-claude.mjs");
  fs.writeFileSync(fake,fs.readFileSync(path.join(here,"fakes","fake-claude.mjs"),"utf8").replace('errorCode: "credits_required"','rateLimitType: "five_hour"'));
  configure({workerCommandArgs:[fake],workerChains:{...baseConfig.workerChains,medium:[{worker:"claude",model:"m1",effort:"high"},{worker:"claude",model:"m2",effort:"high"},{worker:"gemini",model:"g1"}]}},{m1:[{action:"credits"}],m2:[{action:"credits"}],g1:[{write:{"a.txt":"done"}}]});
  const host=makeHost(makeRepo({"a.txt":"old"})); await host.on();
  await host.call("delegate_implementation",{task:"change",profile:"medium",allowedPaths:["a.txt"],implementationGuide:guide(["a.txt"])});
  assert.deepEqual(calls().map(c=>c.model),["m1","g1"]);
});

test("AUDIT: transient retries resume the partially completed session", async () => {
  const fake=path.join(root,"transient-claude.mjs");
  const original=fs.readFileSync(path.join(here,"fakes","fake-claude.mjs"),"utf8");
  fs.writeFileSync(fake,original.replace('if (step.action === "credits") {',`if (step.action === "transient") { emit({type:"result",is_error:true,result:"503 service unavailable",session_id:sessionId,usage}); process.exit(1); }\nif (step.action === "credits") {`));
  configure({workerCommandArgs:[fake]},{"claude-sonnet-5":[{action:"transient",write:{"a.txt":"partial"}},{write:{"a.txt":"done"}}]});
  const host=makeHost(makeRepo({"a.txt":"old"})); await host.on();
  await host.call("delegate_implementation",{task:"change",profile:"medium",allowedPaths:["a.txt"],implementationGuide:guide(["a.txt"])});
  assert.equal(calls().length,2); assert.ok(calls()[1].resume); assert.match(calls()[1].prompt,/RETRY AFTER TRANSIENT/);
});

test("AUDIT: credit exhaustion in correction fails over and verifies the repair", async () => {
  configure({}, {"claude-sonnet-5":[{write:{"value.txt":"bad"}},{action:"credits"}],"claude-opus-5-5":[{write:{"value.txt":"ok"}}]});
  const host=makeHost(makeRepo({"value.txt":"ok","check.test.mjs":PASSING_CHECK})); await host.on();
  const result=await host.call("delegate_implementation",{task:"change",profile:"medium",allowedPaths:["value.txt"],implementationGuide:guide(["value.txt"],["node --test check.test.mjs"])});
  assert.equal(result.isError,false); assert.deepEqual(calls().map(c=>c.model),["claude-sonnet-5","claude-sonnet-5","claude-opus-5-5"]);
  const learned=JSON.parse(fs.readFileSync(dataFile,"utf8")); assert.equal(learned.outcomes.at(-1).failed,false); assert.equal(learned.outcomes.at(-1).verification,"fixed");
});

test("AUDIT: API review receives deeply nested changed files", async () => {
  configure({independentReviewProfiles:["critical"],reviewApi:baseConfig.reviewApi},{"claude-fable-5-1":[{write:{"src/a/b/c/deep.ts":"export const n=2;\n"}}]});
  const host=makeHost(makeRepo({"src/a/b/c/deep.ts":"export const n=1;\n"})); await host.on();
  await host.call("delegate_implementation",{task:"change",profile:"critical",allowedPaths:["src"],implementationGuide:guide(["src"])});
  assert.equal(host.apiCalls.length,1);
  const material=host.apiCalls[0].content.split("FILES (current content)\n")[1];
  assert.match(material,/=== src\/a\/b\/c\/deep.ts ===/);
});

test("AUDIT: unrelated prompts cannot inherit a flagship grant", async () => {
  configure({supervisorChain:[{provider:"openai-codex",model:"gpt-5.5"},{provider:"google",model:"gemini-3.8-flash"}],flagshipModels:["gpt-5.5"]}, {"claude-fable-5-1":[{write:{"a.txt":"done"}}]});
  const host=makeHost(makeRepo({"a.txt":"old"})); host.setAnswer("SI"); await host.on();
  await host.handlers.get("before_agent_start")({prompt:"critical task"},host.ctx);
  await host.call("plan_task",{task:"critical task",profile:"critical",rationale:"test"});
  await host.call("delegate_implementation",{task:"critical task",allowedPaths:["a.txt"],implementationGuide:guide(["a.txt"])});
  await host.handlers.get("agent_settled")({outcome:"completed"},host.ctx);
  await host.handlers.get("before_agent_start")({prompt:"An unrelated small question"},host.ctx);
  assert.equal(host.ctx.model.id,"gemini-3.8-flash"); assert.equal(host.questions.length,1);
  assert.equal(host.ctx.auditState.taskPacket.phase,"implemented");
});

const FAKE_CLAUDE = fs.readFileSync(path.join(here, "fakes", "fake-claude.mjs"), "utf8");
const FAKE_GEMINI = fs.readFileSync(path.join(here, "fakes", "fake-gemini.mjs"), "utf8");
const geminiOnly = { ...baseConfig.workerChains, medium: [{ worker: "gemini", model: "g1" }] };

test("AUDIT A9: a Gemini implementer's correction resumes its own session", async () => {
	configure({ workerChains: geminiOnly }, { g1: [{ write: { "value.txt": "bad" } }, { write: { "value.txt": "ok" } }] });
	const host = makeHost(makeRepo({ "value.txt": "ok", "check.test.mjs": PASSING_CHECK }));
	await host.on();
	const result = await host.call("delegate_implementation", { task: "change", profile: "medium", allowedPaths: ["value.txt"], implementationGuide: guide(["value.txt"], ["node --test check.test.mjs"]) });
	assert.equal(result.details.verification, "fixed");
	const [first, correction] = calls();
	assert.equal(first.resume, undefined);
	assert.equal(correction.resume, "gemini-session");
	assert.match(correction.prompt, /\[CORRECTION ROUND 1\]/);
});

test("a resumed correction receives only the correction, not the guide and diff again", async () => {
	configure({}, { "claude-sonnet-5": [{ write: { "value.txt": "bad" } }, { write: { "value.txt": "ok" } }] });
	const host = makeHost(makeRepo({ "value.txt": "ok", "check.test.mjs": PASSING_CHECK }));
	await host.on();
	await host.call("delegate_implementation", { task: "change", profile: "medium", allowedPaths: ["value.txt"], implementationGuide: guide(["value.txt"], ["node --test check.test.mjs"]) });
	const correction = calls()[1];
	assert.ok(correction.resume);
	assert.match(correction.prompt, /^\[CORRECTION ROUND 1\][\s\S]*node --test check\.test\.mjs/);
	assert.doesNotMatch(correction.prompt, /FILE GUIDE|\[CURRENT WORK\]/);
});

function scriptedClaude(name: string, actions: string): string {
	const file = path.join(root, `${name}.mjs`);
	fs.writeFileSync(file, FAKE_CLAUDE.replace('if (step.action === "credits") {', `${actions}\nif (step.action === "credits") {`));
	return file;
}
const MAXTURNS = 'if (step.action === "maxturns") { emit({ type: "result", subtype: "error_max_turns", is_error: true, session_id: sessionId, usage }); process.exit(1); }';

test("AUDIT A10 / AUDIT-2 B3: the turn limit stops the chain, keeps work and session, and the same session resumes", async () => {
	configure({ workerCommandArgs: [scriptedClaude("maxturns-claude", MAXTURNS)] }, { "claude-sonnet-5": [{ action: "maxturns", write: { "a.txt": "partial" } }, { write: { "a.txt": "done" } }] });
	const host = makeHost(makeRepo({ "a.txt": "old" }));
	await host.on();
	const stopped = await host.call("delegate_implementation", { task: "change", profile: "medium", allowedPaths: ["a.txt"], implementationGuide: guide(["a.txt"]) });
	assert.equal(stopped.isError, true);
	assert.match(stopped.details.limitReached, /turn limit/);
	assert.equal(stopped.details.sessionPreserved, true);
	assert.match(stopped.content[0].text, /STOPPED: worker turn limit/);
	assert.deepEqual(calls().map((call) => [call.model, call.maxTurns]), [["claude-sonnet-5", String(baseConfig.workerMaxTurns.medium)]], "no failover to another model");
	assert.equal(fs.readFileSync(path.join(host.ctx.cwd, "a.txt"), "utf8"), "partial");
	const resumed = await host.call("delegate_implementation", { task: "finish", continuePrevious: true, allowedPaths: ["a.txt"], implementationGuide: guide(["a.txt"]) });
	assert.equal(resumed.isError, false);
	assert.ok(calls()[1].resume, "the session that hit the limit continues");
	const outcomes = JSON.parse(fs.readFileSync(dataFile, "utf8")).outcomes;
	assert.equal(outcomes[0].failed, true, "hitting the turn limit is recorded as a difficulty signal");
});

test("zero timeouts mean no limit, not an immediate kill", async () => {
	configure({ workerTimeoutMinutes: 0, delegationTimeoutMinutes: 0 }, { "claude-sonnet-5": [{ write: { "a.txt": "done" } }] });
	const host = makeHost(makeRepo({ "a.txt": "old" }));
	await host.on();
	const result = await host.call("delegate_implementation", { task: "change", profile: "medium", allowedPaths: ["a.txt"], implementationGuide: guide(["a.txt"]) });
	assert.equal(result.isError, false, result.content[0].text);
	assert.equal(fs.readFileSync(path.join(host.ctx.cwd, "a.txt"), "utf8"), "done");
});

test("AUDIT A6/A10: an API review cut off by its output limit gives no verdict and the next reviewer runs", async () => {
	configure({ independentReviewProfiles: ["critical"], reviewApi: baseConfig.reviewApi }, { "claude-fable-5-1": [{ write: { "a.txt": "done" } }], "gemini-3.1-pro-preview": [{ text: "No material defect.\nVERDICT: PASS" }] });
	const host = makeHost(makeRepo({ "a.txt": "old" }));
	const limits: number[] = [];
	host.ctx.modelRegistry.streamSimple = (_model: any, _context: any, options: any) => ({
		result: async () => {
			limits.push(options.maxTokens);
			return { role: "assistant", content: [{ type: "text", text: "Partial analysis\nVERDICT: PASS" }], stopReason: "length", usage: { input: 500, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 550, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.002 } } };
		},
	});
	await host.on();
	const result = await host.call("delegate_implementation", { task: "change", profile: "critical", allowedPaths: ["a.txt"], implementationGuide: guide(["a.txt"]) });
	assert.deepEqual(limits, [baseConfig.reviewMaxTokens]);
	assert.equal(result.details.reviewVerdict, "pass");
	assert.ok(calls().some((call) => call.cli === "gemini" && call.mode === "plan"), "the CLI reviewer produced the verdict");
});

test("AUDIT A11: the delegation diff leaves out earlier uncommitted edits to the same file", async () => {
	configure({}, { "claude-sonnet-5": [{ write: { "a.txt": "PRE\nNEW\n" } }] });
	const repo = makeRepo({ "a.txt": "one\ntwo\n" });
	fs.writeFileSync(path.join(repo, "a.txt"), "PRE\ntwo\n");
	const host = makeHost(repo);
	await host.on();
	const result = await host.call("delegate_implementation", { task: "change", profile: "medium", allowedPaths: ["a.txt"], implementationGuide: guide(["a.txt"]) });
	const text = result.content[0].text;
	assert.match(text, /DIFF \(this delegation only\)[\s\S]*-two[\s\S]*\+NEW/);
	assert.doesNotMatch(text, /^[-+]PRE/m);
});

test("AUDIT A12: Gemini usage is attributed to every model it reports", async () => {
	const fake = path.join(root, "two-model-gemini.mjs");
	fs.writeFileSync(fake, FAKE_GEMINI.replace("const stats = { models: { [model]: { tokens: { input: 1000, candidates: 50, thoughts: 10, cached: 0 } } } };", 'const stats = { models: { [model]: { tokens: { input: 1000, candidates: 50, thoughts: 10, cached: 0 } }, "gemini-helper": { tokens: { input: 200, candidates: 5, thoughts: 0, cached: 0 } } } };'));
	configure({ geminiCommandArgs: [fake], workerChains: geminiOnly }, { g1: [{ write: { "a.txt": "done" } }] });
	const host = makeHost(makeRepo({ "a.txt": "old" }));
	await host.on();
	await host.call("delegate_implementation", { task: "change", profile: "medium", allowedPaths: ["a.txt"], implementationGuide: guide(["a.txt"]) });
	const metrics = host.ctx.auditState.metrics;
	const byModel = Object.values(metrics.byModel) as Array<{ model: string; input: number }>;
	assert.equal(byModel.find((entry) => entry.model === "g1")?.input, 1000);
	assert.equal(byModel.find((entry) => entry.model === "gemini-helper")?.input, 200);
	assert.equal(metrics.geminiCalls, 1, "one invocation, however many models it used");
});

test("AUDIT A2/A12: a supervisor probe is capped and accounted", async () => {
	configure({ supervisorChain: [{ provider: "openai-codex", model: "gpt-5.5" }], probeOnActivate: true }, {});
	const host = makeHost(makeRepo({ "a.txt": "old" }));
	const limits: number[] = [];
	host.ctx.modelRegistry.complete = async (_model: any, _context: any, options: any) => {
		limits.push(options.maxTokens);
		return { stopReason: "stop", content: [{ type: "text", text: "OK" }], usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
	};
	await host.on();
	assert.deepEqual(limits, [baseConfig.probeMaxTokens]);
	const metrics = host.ctx.auditState.metrics;
	assert.ok((Object.values(metrics.byModel) as Array<{ model: string; runs: number }>).some((entry) => entry.model === "gpt-5.5" && entry.runs === 1));
	assert.ok(metrics.byRole.probe);
});

test("a task planned in one prompt keeps its profile and identity when delegated after the user's confirmation", async () => {
	configure({}, { "claude-opus-5-5": [{ write: { "a.txt": "done" } }] });
	const host = makeHost(makeRepo({ "a.txt": "old" }));
	await host.on();
	await host.handlers.get("before_agent_start")({ prompt: "Plan the rework" }, host.ctx);
	const planned = await host.call("plan_task", { task: "Rework a.txt", profile: "large", rationale: "test" });
	await host.handlers.get("before_agent_start")({ prompt: "Yes, go ahead" }, host.ctx);
	const result = await host.call("delegate_implementation", { task: "Rework a.txt", allowedPaths: ["a.txt"], implementationGuide: guide(["a.txt"]) });
	assert.equal(result.details.profile, "large");
	assert.equal(result.details.taskPacketId, planned.details.taskId);
	assert.equal(calls()[0].model, baseConfig.workerChains.large[0].model);
});

// ── Second audit (AUDIT-2.md) ──────────────────────────────────────────────────────────────────────

import { parseVerdict } from "../learning.ts";

test("AUDIT-2 B1: a regression left by an earlier delegation stays a regression of the task and blocks acceptance", async () => {
	configure({ maxCorrectionRounds: 0 }, { "claude-sonnet-5": [{ write: { "value.txt": "bad" } }, { write: { "other.txt": "x\n" } }] });
	const host = makeHost(makeRepo({ "value.txt": "ok", "check.test.mjs": PASSING_CHECK }));
	await host.on();
	const first = await host.call("delegate_implementation", { task: "change", profile: "medium", allowedPaths: ["value.txt"], implementationGuide: guide(["value.txt"], ["node --test check.test.mjs"]) });
	assert.equal(first.details.verification, "failed");
	// A new prompt: the failed task carries over, so even a delegation without continuePrevious keeps its baseline.
	await host.handlers.get("before_agent_start")({ prompt: "Go on" }, host.ctx);
	const second = await host.call("delegate_implementation", { task: "follow-up", profile: "medium", allowedPaths: ["value.txt", "other.txt"], implementationGuide: guide(["value.txt", "other.txt"], ["node --test check.test.mjs"]) });
	assert.equal(second.details.taskPacketId, first.details.taskPacketId);
	assert.equal(second.details.verification, "failed");
	assert.match(second.content[0].text, /FAIL \(regression\)/);
	await assert.rejects(host.call("complete_task", { decision: "accept", summary: "Checks were already failing before the change." }), /cannot be accepted/);
});

test("AUDIT-2 B2: a task counts with its worst delegation, for raising and for lowering", () => {
	const base = { evidenceVersion: 2 as const, taskKind: "general", at: Date.now(), repo: "r", profile: "medium", worker: "claude", model: "m", effort: "high", correctionRounds: 0, review: "none" as const, tokens: 0, costUsd: 0 };
	const target = { profile: "medium", model: "m", configured: "high" as const, repo: "r", kind: "general" };
	const raising = emptyLearning();
	for (let i = 0; i < 4; i++) {
		recordOutcome(raising, { ...base, taskId: `t${i}`, verification: "failed", failed: true });
		recordOutcome(raising, { ...base, taskId: `t${i}`, verification: "passed", failed: false });
	}
	assert.equal(tuneEfforts(raising, [target]).length, 1, "tasks repaired by a second delegation still raise effort");
	const lowering = emptyLearning();
	for (let i = 0; i < 20; i++) {
		recordOutcome(lowering, { ...base, taskId: `t${i}`, verification: "unverified", failed: false, accepted: true });
		recordOutcome(lowering, { ...base, taskId: `t${i}`, verification: "passed", failed: false, accepted: true });
	}
	assert.deepEqual(tuneEfforts(lowering, [target]), [], "lowering needs every delegation of every task verified green at the first attempt");
});

test("AUDIT-2 B4: the delegation time limit never kills a running worker", async () => {
	configure({ workerCommandArgs: [scriptedClaude("slow-claude", 'if (step.action === "slow") { await new Promise((resolve) => setTimeout(resolve, 2000)); }')], delegationTimeoutMinutes: 0.01 }, { "claude-sonnet-5": [{ action: "slow", write: { "a.txt": "done" } }] });
	const host = makeHost(makeRepo({ "a.txt": "old" }));
	await host.on();
	const result = await host.call("delegate_implementation", { task: "change", profile: "medium", allowedPaths: ["a.txt"], implementationGuide: guide(["a.txt"]) });
	assert.equal(result.isError, false, result.content[0].text);
	assert.equal(fs.readFileSync(path.join(host.ctx.cwd, "a.txt"), "utf8"), "done");
});

test("AUDIT-2 B4: past the time limit, no correction round or review starts, and the session is kept", async () => {
	configure({ workerCommandArgs: [scriptedClaude("slow-claude-2", 'if (step.action === "slow") { await new Promise((resolve) => setTimeout(resolve, 1500)); }')], delegationTimeoutMinutes: 0.01, independentReviewProfiles: ["medium"] }, { "claude-sonnet-5": [{ action: "slow", write: { "value.txt": "bad" } }] });
	const host = makeHost(makeRepo({ "value.txt": "ok", "check.test.mjs": PASSING_CHECK }));
	await host.on();
	const result = await host.call("delegate_implementation", { task: "change", profile: "medium", allowedPaths: ["value.txt"], implementationGuide: guide(["value.txt"], ["node --test check.test.mjs"]) });
	assert.equal(calls().length, 1, "no correction round after the limit");
	assert.match(result.details.limitReached, /delegation time limit/);
	assert.equal(result.details.sessionPreserved, true);
	assert.match(result.content[0].text, /No further correction round/);
});

test("AUDIT-2 B5: a reviewer that fails without a provider error hands over to the next reviewer, with the profile's turn limit", async () => {
	configure({ workerCommandArgs: [scriptedClaude("review-maxturns", MAXTURNS)], independentReviewProfiles: ["large"], flagshipModels: ["claude-fable-5-1"] }, { "claude-opus-5-5": [{ write: { "a.txt": "done" } }], "claude-sonnet-5": [{ action: "maxturns" }], "gemini-3.1-pro-preview": [{ text: "No defect.\nVERDICT: PASS" }] });
	const host = makeHost(makeRepo({ "a.txt": "old" }));
	await host.on();
	const result = await host.call("delegate_implementation", { task: "change", profile: "large", allowedPaths: ["a.txt"], implementationGuide: guide(["a.txt"]) });
	assert.equal(result.details.reviewVerdict, "pass");
	assert.equal(calls().find((call) => call.model === "claude-sonnet-5")?.maxTurns, String(baseConfig.workerMaxTurns.large));
	assert.ok(calls().some((call) => call.cli === "gemini"));
});

test("AUDIT-2 B6: the default configuration does not switch supervisor models around a small task", async () => {
	assert.deepEqual(baseConfig.supervisorProfiles ?? {}, {}, "per-profile supervisors switch models mid-task; opt in only after measuring");
	configure({ supervisorChain: [{ provider: "openai-codex", model: "gpt-5.5" }, { provider: "google", model: "gemini-3.8-flash" }] }, { "claude-sonnet-5": [{ write: { "a.txt": "done" } }] });
	const host = makeHost(makeRepo({ "a.txt": "old" }));
	await host.on();
	await host.handlers.get("before_agent_start")({ prompt: "Fix a.txt" }, host.ctx);
	const before = host.notifications.length;
	await host.call("delegate_implementation", { task: "change", profile: "small", allowedPaths: ["a.txt"], implementationGuide: guide(["a.txt"]) });
	await host.call("complete_task", { decision: "accept", summary: "Reviewed the diff; trivial change." });
	assert.deepEqual(host.notifications.slice(before).filter((text) => text.startsWith("Supervisor model:")), []);
});

test("AUDIT-2 B6: complete_task never switches the supervisor before the final answer", async () => {
	configure({ supervisorChain: [{ provider: "openai-codex", model: "gpt-5.5" }], supervisorProfiles: { small: [{ provider: "google", model: "gemini-3.8-flash" }] } }, { "claude-sonnet-5": [{ write: { "a.txt": "done" } }] });
	const host = makeHost(makeRepo({ "a.txt": "old" }));
	await host.on();
	await host.handlers.get("before_agent_start")({ prompt: "Fix a.txt" }, host.ctx);
	await host.call("delegate_implementation", { task: "change", profile: "small", allowedPaths: ["a.txt"], implementationGuide: guide(["a.txt"]) });
	assert.equal(host.ctx.model.id, "gemini-3.8-flash", "the configured small-task supervisor");
	await host.call("complete_task", { decision: "accept", summary: "Reviewed the diff; trivial change." });
	assert.equal(host.ctx.model.id, "gemini-3.8-flash");
	await host.handlers.get("before_agent_start")({ prompt: "Something else" }, host.ctx);
	assert.equal(host.ctx.model.id, "gpt-5.5", "the next prompt selects the general supervisor");
});

test("AUDIT-2 B6: an unfinished critical task keeps its approved supervisor into the next prompt", async () => {
	configure({ supervisorChain: [{ provider: "openai-codex", model: "gpt-5.5" }, { provider: "google", model: "gemini-3.8-flash" }], flagshipModels: ["gpt-5.5"] }, {});
	const host = makeHost(makeRepo({ "a.txt": "old" }));
	host.setAnswer("SI");
	await host.on();
	await host.handlers.get("before_agent_start")({ prompt: "Plan the critical change" }, host.ctx);
	await host.call("plan_task", { task: "critical change", profile: "critical", rationale: "test" });
	assert.equal(host.ctx.model.id, "gpt-5.5");
	const before = host.notifications.length;
	await host.handlers.get("before_agent_start")({ prompt: "Yes, go ahead" }, host.ctx);
	assert.equal(host.ctx.model.id, "gpt-5.5");
	assert.deepEqual(host.notifications.slice(before).filter((text) => text.startsWith("Supervisor model:")), []);
	assert.equal(host.questions.length, 1, "approved once for the whole task");
});

test("AUDIT-2 B7: accepting a multi-delegation task reviews the whole task, and a MAJOR finding blocks it", async () => {
	configure({ independentReviewProfiles: ["large"], flagshipModels: ["claude-fable-5-1"] }, {
		"claude-opus-5-5": [{ write: { "a.txt": "one\n" } }, { text: "The two steps conflict.\nVERDICT: MAJOR" }],
		"claude-sonnet-5": [{ text: "Step fine.\nVERDICT: PASS" }, { write: { "b.txt": "two\n" } }],
	});
	const host = makeHost(makeRepo({ "a.txt": "old\n" }));
	await host.on();
	const first = await host.call("delegate_implementation", { task: "step one", profile: "large", allowedPaths: ["a.txt"], implementationGuide: guide(["a.txt"]) });
	assert.equal(first.details.reviewVerdict, "pass");
	const second = await host.call("delegate_implementation", { task: "step two", profile: "medium", allowedPaths: ["b.txt"], implementationGuide: guide(["b.txt"]) });
	assert.equal(second.details.reviewVerdict, "none", "a medium step gets no review of its own");
	const accepted = await host.call("complete_task", { decision: "accept", summary: "Both steps reviewed by me." });
	assert.equal(accepted.isError, true);
	assert.match(accepted.content[0].text, /whole task found material defects/);
	const review = calls().at(-1)!;
	assert.equal(review.model, "claude-opus-5-5");
	assert.match(review.prompt, /OF THE WHOLE TASK[\s\S]*\+one[\s\S]*\+two|OF THE WHOLE TASK[\s\S]*\+two[\s\S]*\+one/);
	assert.equal(host.ctx.auditState.taskPacket.phase, "failed");
});

test("AUDIT-2 B8: after a correction failover the outcome is credited to the model that did the work", async () => {
	configure({}, { "claude-sonnet-5": [{ write: { "value.txt": "bad" } }, { action: "credits" }], "claude-opus-5-5": [{ write: { "value.txt": "ok" } }] });
	const host = makeHost(makeRepo({ "value.txt": "ok", "check.test.mjs": PASSING_CHECK }));
	await host.on();
	await host.call("delegate_implementation", { task: "change", profile: "medium", allowedPaths: ["value.txt"], implementationGuide: guide(["value.txt"], ["node --test check.test.mjs"]) });
	const outcomes = JSON.parse(fs.readFileSync(dataFile, "utf8")).outcomes;
	assert.deepEqual(outcomes.map((item: { model: string; verification: string }) => [item.model, item.verification]), [["claude-sonnet-5", "fixed"]]);
});

test("AUDIT-2 B9: poor quality across task kinds raises effort for a new kind", () => {
	const state = emptyLearning();
	const base = { evidenceVersion: 2 as const, at: Date.now(), repo: "r", profile: "medium", worker: "claude", model: "m", effort: "high", verification: "failed" as const, correctionRounds: 0, review: "none" as const, failed: true, tokens: 0, costUsd: 0 };
	["feature", "bugfix", "docs", "tests"].forEach((kind, i) => recordOutcome(state, { ...base, taskKind: kind, taskId: `t${i}` }));
	assert.equal(tuneEfforts(state, [{ profile: "medium", model: "m", configured: "high", repo: "r", kind: "refactor" }]).length, 1);
	assert.equal(effectiveEffort(state, "medium", "m", "high", "r", "refactor"), "xhigh");
});

test("AUDIT-2 B10: the implementer's own model reviews only after the other family", async () => {
	configure({ independentReviewProfiles: ["large"], flagshipModels: ["claude-fable-5-1"] }, { "claude-opus-5-5": [{ write: { "a.txt": "done" } }], "claude-sonnet-5": [{ action: "credits" }], "gemini-3.1-pro-preview": [{ text: "Fine.\nVERDICT: PASS" }] });
	const host = makeHost(makeRepo({ "a.txt": "old" }));
	await host.on();
	const result = await host.call("delegate_implementation", { task: "change", profile: "large", allowedPaths: ["a.txt"], implementationGuide: guide(["a.txt"]) });
	assert.equal(result.details.reviewVerdict, "pass");
	assert.deepEqual(calls().map((call) => call.model), ["claude-opus-5-5", "claude-sonnet-5", "gemini-3.1-pro-preview"]);
});

test("AUDIT-2 B11: run_verification never reopens an accepted task, nor fails a task for a check red since its start", async () => {
	const broken = `import test from "node:test";\nimport assert from "node:assert";\ntest("x", () => assert.fail("unrelated"));\n`;
	configure({}, { "claude-sonnet-5": [{ write: { "a.txt": "done" } }] });
	const host = makeHost(makeRepo({ "a.txt": "old", "broken.test.mjs": broken }));
	await host.on();
	await host.call("delegate_implementation", { task: "change", profile: "small", allowedPaths: ["a.txt"], implementationGuide: guide(["a.txt"], ["node --test broken.test.mjs"]) });
	await host.call("run_verification", { command: "node --test broken.test.mjs" });
	assert.equal(host.ctx.auditState.taskPacket.phase, "implemented", "red since the task started");
	await host.call("complete_task", { decision: "accept", summary: "Reviewed the diff; trivial change." });
	await host.call("run_verification", { command: "node --test broken.test.mjs" });
	assert.equal(host.ctx.auditState.taskPacket.phase, "completed");
});

test("AUDIT-2 B12: an unavailable model keeps its full cooldown during a delegation", async () => {
	configure({ workerCommandArgs: [scriptedClaude("unavailable-claude", 'if (step.action === "unavailable") { emit({ type: "result", is_error: true, result: "model not found: " + model, session_id: sessionId, usage }); process.exit(1); }')] }, { "claude-sonnet-5": [{ action: "unavailable" }], "claude-opus-5-5": [{ write: { "a.txt": "done" } }] });
	const host = makeHost(makeRepo({ "a.txt": "old" }));
	await host.on();
	await host.call("delegate_implementation", { task: "change", profile: "medium", allowedPaths: ["a.txt"], implementationGuide: guide(["a.txt"]) });
	const blocked = host.ctx.auditState.health["claude-cli:model:claude-sonnet-5"];
	assert.ok(blocked.blockedUntil - Date.now() > (baseConfig.unavailableCooldownMinutes - 5) * 60_000);
});

test("AUDIT-2 B13: a closing remark after the verdict line is tolerated; a verdict inside the body is not", () => {
	assert.equal(parseVerdict("Findings...\nVERDICT: MINOR\nThanks for the clear guide."), "minor");
	assert.equal(parseVerdict("VERDICT: PASS\nline one\nline two\nline three"), "none");
});

test("AUDIT-2 B13: instruction files along the authorized paths reach the worker", async () => {
	configure({}, { "claude-sonnet-5": [{ write: { "pkg/lib/x.txt": "new" } }] });
	const host = makeHost(makeRepo({ "AGENTS.md": "Root rule.\n", "pkg/AGENTS.md": "Package rule: keep exports sorted.\n", "pkg/lib/x.txt": "old" }));
	await host.on();
	await host.call("delegate_implementation", { task: "change", profile: "medium", allowedPaths: ["pkg/lib/x.txt"], implementationGuide: guide(["pkg/lib/x.txt"]) });
	assert.match(calls()[0].prompt, /REPOSITORY RULES[\s\S]*Root rule[\s\S]*Package rule: keep exports sorted/);
});

