// End-to-end tests of the real extension against fake Claude Code and Pi CLIs, a fake Pi host and real Git repositories.
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
		"anthropic/claude-opus-5-5": { provider: "anthropic", id: "claude-opus-5-5", name: "Claude Opus 5.5" },
		"openai-codex/gpt-5.5": { provider: "openai-codex", id: "gpt-5.5", name: "GPT-5.5" },
		"openai-codex/gpt-6-astra": { provider: "openai-codex", id: "gpt-6-astra", name: "GPT-6 Astra" },
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
  configure({supervisorChain:[{provider:"openai-codex",model:"gpt-6-astra"}],flagshipModels:["gpt-6-astra"],probeOnActivate:true}, {});
  const host=makeHost(makeRepo({"a.txt":"old"})); let probes=0;
  host.ctx.modelRegistry.complete=async()=>{probes++; return {stopReason:"stop",usage:{totalTokens:999}};};
  await host.on();
  assert.equal(probes,0); assert.equal(host.questions.length,0);
  assert.equal(Object.keys(host.ctx.auditState.metrics.byModel).some(k=>k.includes("gpt-6-astra")),false);
});

test("AUDIT: account exhaustion skips subsequent models on the same account", async () => {
  const fake=path.join(root,"account-claude.mjs");
  fs.writeFileSync(fake,fs.readFileSync(path.join(here,"fakes","fake-claude.mjs"),"utf8").replace('errorCode: "credits_required"','rateLimitType: "five_hour"'));
  configure({workerCommandArgs:[fake],workerChains:{...baseConfig.workerChains,medium:[{worker:"claude",model:"m1",effort:"high"},{worker:"claude",model:"m2",effort:"high"},{worker:"pi",provider:"openai-codex",model:"gpt-5.5",effort:"high"}]}},{m1:[{action:"credits"}],m2:[{action:"credits"}],"gpt-5.5":[{write:{"a.txt":"done"}}]});
  const host=makeHost(makeRepo({"a.txt":"old"})); await host.on();
  await host.call("delegate_implementation",{task:"change",profile:"medium",allowedPaths:["a.txt"],implementationGuide:guide(["a.txt"])});
  assert.deepEqual(calls().map(c=>c.model),["m1","gpt-5.5"]);
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
  configure({}, {"claude-sonnet-5":[{write:{"value.txt":"bad"}},{action:"credits"}],"gpt-5.5":[{write:{"value.txt":"ok"}}]});
  const host=makeHost(makeRepo({"value.txt":"ok","check.test.mjs":PASSING_CHECK})); await host.on();
  const result=await host.call("delegate_implementation",{task:"change",profile:"medium",allowedPaths:["value.txt"],implementationGuide:guide(["value.txt"],["node --test check.test.mjs"])});
  assert.equal(result.isError,false); assert.deepEqual(calls().map(c=>c.model),["claude-sonnet-5","claude-sonnet-5","gpt-5.5"]);
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
  configure({supervisorChain:[{provider:"openai-codex",model:"gpt-6-astra"},{provider:"openai-codex",model:"gpt-6-sol"}],flagshipModels:["gpt-6-astra"]}, {"claude-fable-5-1":[{write:{"a.txt":"done"}}]});
  const host=makeHost(makeRepo({"a.txt":"old"})); host.setAnswer("Yes"); await host.on();
  await host.handlers.get("before_agent_start")({prompt:"critical task"},host.ctx);
  await host.call("plan_task",{task:"critical task",profile:"critical",rationale:"test"});
  await host.call("delegate_implementation",{task:"critical task",allowedPaths:["a.txt"],implementationGuide:guide(["a.txt"])});
  await host.handlers.get("agent_settled")({outcome:"completed"},host.ctx);
  await host.handlers.get("before_agent_start")({prompt:"An unrelated small question"},host.ctx);
  assert.equal(host.ctx.model.id,"gpt-6-sol"); assert.equal(host.questions.length,1);
  assert.equal(host.ctx.auditState.taskPacket.phase,"implemented");
});

const FAKE_CLAUDE = fs.readFileSync(path.join(here, "fakes", "fake-claude.mjs"), "utf8");

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
	configure({ independentReviewProfiles: ["critical"], reviewApi: baseConfig.reviewApi, flagshipModels: ["gpt-6-astra"] }, { "claude-fable-5-1": [{ write: { "a.txt": "done" } }], "gpt-5.5": [{ text: "No material defect.\nVERDICT: PASS" }] });
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
	assert.ok(calls().some((call) => call.cli === "pi" && call.model === "gpt-5.5" && call.tools === "read,grep,find,ls"), "the read-only CLI reviewer produced the verdict");
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

test("AUDIT-2 B5: a reviewer stopped at the profile's turn limit hands over to the next reviewer", async () => {
	// Opus implements; the first independent reviewer is GPT-5.5 through Pi, which keeps working until the extension stops it.
	configure({ independentReviewProfiles: ["large"], flagshipModels: ["claude-fable-5-1", "gpt-6-astra"] }, { "claude-opus-5-5": [{ write: { "a.txt": "done" } }], "gpt-5.5": [{ action: "turns" }], "claude-sonnet-5": [{ text: "No defect.\nVERDICT: PASS" }] });
	const host = makeHost(makeRepo({ "a.txt": "old" }));
	await host.on();
	const result = await host.call("delegate_implementation", { task: "change", profile: "large", allowedPaths: ["a.txt"], implementationGuide: guide(["a.txt"]) });
	assert.equal(result.details.reviewVerdict, "pass");
	assert.deepEqual(calls().map((call) => call.model), ["claude-opus-5-5", "gpt-5.5", "claude-sonnet-5"]);
});

test("AUDIT-2 B6: the default configuration does not switch supervisor models around a small task", async () => {
	assert.deepEqual(baseConfig.supervisorProfiles ?? {}, {}, "per-profile supervisors switch models mid-task; opt in only after measuring");
	configure({ supervisorChain: [{ provider: "openai-codex", model: "gpt-5.5" }, { provider: "openai-codex", model: "gpt-6-sol" }] }, { "claude-sonnet-5": [{ write: { "a.txt": "done" } }] });
	const host = makeHost(makeRepo({ "a.txt": "old" }));
	await host.on();
	await host.handlers.get("before_agent_start")({ prompt: "Fix a.txt" }, host.ctx);
	const before = host.notifications.length;
	await host.call("delegate_implementation", { task: "change", profile: "small", allowedPaths: ["a.txt"], implementationGuide: guide(["a.txt"]) });
	await host.call("complete_task", { decision: "accept", summary: "Reviewed the diff; trivial change." });
	assert.deepEqual(host.notifications.slice(before).filter((text) => text.startsWith("Supervisor model:")), []);
});

test("AUDIT-2 B6: complete_task never switches the supervisor before the final answer", async () => {
	configure({ supervisorChain: [{ provider: "openai-codex", model: "gpt-5.5" }], supervisorProfiles: { small: [{ provider: "openai-codex", model: "gpt-6-sol" }] } }, { "claude-sonnet-5": [{ write: { "a.txt": "done" } }] });
	const host = makeHost(makeRepo({ "a.txt": "old" }));
	await host.on();
	await host.handlers.get("before_agent_start")({ prompt: "Fix a.txt" }, host.ctx);
	await host.call("delegate_implementation", { task: "change", profile: "small", allowedPaths: ["a.txt"], implementationGuide: guide(["a.txt"]) });
	assert.equal(host.ctx.model.id, "gpt-6-sol", "the configured small-task supervisor");
	await host.call("complete_task", { decision: "accept", summary: "Reviewed the diff; trivial change." });
	assert.equal(host.ctx.model.id, "gpt-6-sol");
	await host.handlers.get("before_agent_start")({ prompt: "Something else" }, host.ctx);
	assert.equal(host.ctx.model.id, "gpt-5.5", "the next prompt selects the general supervisor");
});

test("AUDIT-2 B6: an unfinished critical task keeps its approved supervisor into the next prompt", async () => {
	configure({ supervisorChain: [{ provider: "openai-codex", model: "gpt-6-astra" }, { provider: "openai-codex", model: "gpt-6-sol" }], flagshipModels: ["gpt-6-astra"] }, {});
	const host = makeHost(makeRepo({ "a.txt": "old" }));
	host.setAnswer("Yes");
	await host.on();
	await host.handlers.get("before_agent_start")({ prompt: "Plan the critical change" }, host.ctx);
	await host.call("plan_task", { task: "critical change", profile: "critical", rationale: "test" });
	assert.equal(host.ctx.model.id, "gpt-6-astra");
	const before = host.notifications.length;
	await host.handlers.get("before_agent_start")({ prompt: "Yes, go ahead" }, host.ctx);
	assert.equal(host.ctx.model.id, "gpt-6-astra");
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
	configure({}, { "claude-sonnet-5": [{ write: { "value.txt": "bad" } }, { action: "credits" }], "gpt-5.5": [{ write: { "value.txt": "ok" } }] });
	const host = makeHost(makeRepo({ "value.txt": "ok", "check.test.mjs": PASSING_CHECK }));
	await host.on();
	await host.call("delegate_implementation", { task: "change", profile: "medium", allowedPaths: ["value.txt"], implementationGuide: guide(["value.txt"], ["node --test check.test.mjs"]) });
	assert.equal(calls().at(-1)?.model, "gpt-5.5", "GPT through Pi rescued the correction");
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

test("AUDIT-2 B10: reviewers of other families come first, whatever the implementer's family", async () => {
	// A Claude implementer: GPT reviews first; when GPT is out of credits, Sonnet, and Opus itself never before Sonnet.
	configure({ independentReviewProfiles: ["large"], flagshipModels: ["claude-fable-5-1", "gpt-6-astra"] }, { "claude-opus-5-5": [{ write: { "a.txt": "done" } }], "gpt-5.5": [{ action: "credits" }], "claude-sonnet-5": [{ text: "Fine.\nVERDICT: PASS" }] });
	const host = makeHost(makeRepo({ "a.txt": "old" }));
	await host.on();
	const result = await host.call("delegate_implementation", { task: "change", profile: "large", allowedPaths: ["a.txt"], implementationGuide: guide(["a.txt"]) });
	assert.equal(result.details.reviewVerdict, "pass");
	assert.deepEqual(calls().map((call) => call.model), ["claude-opus-5-5", "gpt-5.5", "claude-sonnet-5"]);
	// A GPT implementer: Claude reviews first.
	configure({ independentReviewProfiles: ["large"], flagshipModels: ["claude-fable-5-1", "gpt-6-astra"], workerChains: { ...baseConfig.workerChains, large: [{ worker: "pi", provider: "openai-codex", model: "gpt-5.5", effort: "xhigh" }, ...baseConfig.workerChains.large] } }, { "gpt-5.5": [{ write: { "b.txt": "done" } }], "claude-opus-5-5": [{ text: "Fine.\nVERDICT: PASS" }] });
	fs.writeFileSync(logFile, "");
	const gptHost = makeHost(makeRepo({ "b.txt": "old" }));
	await gptHost.on();
	const gptResult = await gptHost.call("delegate_implementation", { task: "change", profile: "large", allowedPaths: ["b.txt"], implementationGuide: guide(["b.txt"]) });
	assert.equal(gptResult.details.reviewVerdict, "pass");
	assert.deepEqual(calls().map((call) => call.model), ["gpt-5.5", "claude-opus-5-5"]);
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


// ── Interchangeable models: any Pi model (GPT included) implements and reviews ─────────────────────────

import { routeWithEvidence } from "../routing.ts";

const gptFirst = (profile: string, effort = "high") => ({ ...baseConfig.workerChains, [profile]: [{ worker: "pi", provider: "openai-codex", model: "gpt-5.5", effort }, ...baseConfig.workerChains[profile]] });

test("a GPT model implements through Pi: no shell, no extensions, effort as thinking, usage accounted", async () => {
	configure({ workerChains: gptFirst("medium") }, { "gpt-5.5": [{ write: { "a.txt": "done" } }] });
	const host = makeHost(makeRepo({ "a.txt": "old" }));
	await host.on();
	const result = await host.call("delegate_implementation", { task: "change", profile: "medium", allowedPaths: ["a.txt"], implementationGuide: guide(["a.txt"]) });
	assert.equal(result.isError, false, result.content[0].text);
	assert.equal(fs.readFileSync(path.join(host.ctx.cwd, "a.txt"), "utf8"), "done");
	const [call] = calls() as Array<{ cli: string; provider: string; model: string; effort: string; tools: string; extensions: boolean; prompt: string }>;
	assert.deepEqual([call.cli, call.provider, call.model, call.effort], ["pi", "openai-codex", "gpt-5.5", "high"]);
	assert.equal(call.extensions, false, "the worker must not load SupervisedCoding itself");
	assert.doesNotMatch(call.tools, /bash/);
	assert.match(call.prompt, /\[WORKER NOTES\][\s\S]*do not claim checks passed/);
	const entry = (Object.values(host.ctx.auditState.metrics.byModel) as Array<{ worker: string; model: string; input: number; billing?: string }>).find((item) => item.worker === "pi");
	assert.deepEqual([entry?.model, entry?.input, entry?.billing], ["gpt-5.5", 200, "subscription"]);
});

test("a Pi worker's correction resumes its own session", async () => {
	configure({ workerChains: gptFirst("medium") }, { "gpt-5.5": [{ write: { "value.txt": "bad" } }, { write: { "value.txt": "ok" } }] });
	const host = makeHost(makeRepo({ "value.txt": "ok", "check.test.mjs": PASSING_CHECK }));
	await host.on();
	const result = await host.call("delegate_implementation", { task: "change", profile: "medium", allowedPaths: ["value.txt"], implementationGuide: guide(["value.txt"], ["node --test check.test.mjs"]) });
	assert.equal(result.details.verification, "fixed");
	const [first, correction] = calls();
	assert.equal(correction.resume, first.resume, "same --session-id");
	assert.match(correction.prompt, /^\[CORRECTION ROUND 1\]/);
});

test("a Pi worker is stopped by the extension at the profile's turn limit, session kept", async () => {
	configure({ workerChains: gptFirst("small", "medium") }, { "gpt-5.5": [{ action: "turns", write: { "a.txt": "partial" } }] });
	const host = makeHost(makeRepo({ "a.txt": "old" }));
	await host.on();
	const result = await host.call("delegate_implementation", { task: "change", profile: "small", allowedPaths: ["a.txt"], implementationGuide: guide(["a.txt"]) });
	assert.match(result.details.limitReached, /turn limit/);
	assert.equal(result.details.sessionPreserved, true);
	assert.equal(calls().length, 1, "no failover for an execution limit");
});

test("credits exhausted on one subscription fail over to another family through Pi", async () => {
	configure({}, { "claude-sonnet-5": [{ action: "credits" }], "gpt-5.5": [{ write: { "a.txt": "done" } }] });
	const host = makeHost(makeRepo({ "a.txt": "old" }));
	await host.on();
	const result = await host.call("delegate_implementation", { task: "change", profile: "medium", allowedPaths: ["a.txt"], implementationGuide: guide(["a.txt"]) });
	assert.equal(result.isError, false);
	assert.deepEqual(calls().map((call) => call.model), ["claude-sonnet-5", "gpt-5.5"]);
	assert.match(calls()[1].prompt, /\[HANDOFF\]/);
});

test("consult_readonly can ask a GPT reviewer, read-only", async () => {
	configure({}, { "gpt-5.5": [{ text: "The parser is fine." }] });
	const host = makeHost(makeRepo({ "a.txt": "old" }));
	await host.on();
	const result = await host.call("consult_readonly", { purpose: "risk-review", question: "Is a.txt safe?", paths: ["a.txt"], reviewer: "gpt" });
	assert.equal(result.isError, false, result.content[0].text);
	const [call] = calls() as Array<{ cli: string; model: string; tools: string }>;
	assert.deepEqual([call.cli, call.model, call.tools], ["pi", "gpt-5.5", "read,grep,find,ls"]);
});

test("escalation: a model with poor quality at its highest effort yields to the next candidate, in any profile", () => {
	const candidates = [{ worker: "claude", model: "opus", effort: "high" }, { worker: "pi", provider: "openai-codex", model: "gpt-5.5", effort: "xhigh" }, { worker: "pi", provider: "openai-codex", model: "gpt-6-sol", effort: "high" }];
	const poor = (model: string, effort: string | undefined, i: number) => ({ evidenceVersion: 2 as const, taskKind: "bugfix", at: Date.now(), repo: "r", taskId: `${model}-${i}`, profile: "large", worker: "claude", model, effort, verification: "failed" as const, correctionRounds: 0, review: "none" as const, failed: true, tokens: 0, costUsd: 0 });
	const atHigh = [0, 1, 2, 3].map((i) => poor("opus", "high", i));
	assert.equal(routeWithEvidence(candidates, atHigh, "r", "large", "bugfix").candidates[0].model, "opus", "effort is raised first; the model stays");
	const atMax = [0, 1, 2, 3].map((i) => poor("opus", "max", i));
	const escalated = routeWithEvidence(candidates, atMax, "r", "large", "bugfix");
	assert.deepEqual(escalated.candidates.map((item) => item.model), ["gpt-5.5", "opus", "gpt-6-sol"]);
	assert.match(escalated.reason, /escalated to gpt-5\.5/);
	assert.equal(routeWithEvidence(candidates, atMax, "r", "large", "feature").candidates[0].model, "opus", "evidence is per task kind");
});

test("preferWorker selects a model family, whatever tool runs it", async () => {
	configure({}, { "gpt-5.5": [{ write: { "a.txt": "done" } }] });
	const host = makeHost(makeRepo({ "a.txt": "old" }));
	await host.on();
	const result = await host.call("delegate_implementation", { task: "change", profile: "medium", preferWorker: "gpt", allowedPaths: ["a.txt"], implementationGuide: guide(["a.txt"]) });
	assert.equal(result.isError, false);
	assert.deepEqual(calls().map((call) => [call.cli, call.model]), [["pi", "gpt-5.5"]]);
});

// ── Findings of the live test ──────────────────────────────────────────────────────────────────────

test("VERIFY commands that run the same package script execute once", async () => {
	configure({}, { "claude-sonnet-5": [{ write: { "value.txt": "ok" } }] });
	const repo = makeRepo({ "value.txt": "ok", "check.test.mjs": PASSING_CHECK, "package.json": JSON.stringify({ scripts: { test: "node --test" } }) });
	const host = makeHost(repo);
	await host.on();
	const result = await host.call("delegate_implementation", { task: "change", profile: "medium", allowedPaths: ["value.txt"], implementationGuide: guide(["value.txt"], ["npm run test", "node --test"]) });
	assert.match(result.content[0].text, /already run by the extension on the final code: npm run test\. /);
	assert.doesNotMatch(result.content[0].text, /- node --test: pass/);
});

// ── Third audit: verification and lifecycle safety ────────────────────────────────────────────────────

const TWO_CHECKS = `import test from "node:test";\nimport assert from "node:assert";\nimport fs from "node:fs";\ntest("a", () => assert.equal(fs.readFileSync("a.txt", "utf8"), "ok"));\ntest("b", () => assert.equal(fs.readFileSync("b.txt", "utf8"), "ok"));\n`;

test("AUDIT-3: a new failure inside a check already red at the task start is a regression and blocks acceptance", async () => {
	configure({ maxCorrectionRounds: 0 }, { "claude-sonnet-5": [{ write: { "b.txt": "bad" } }] });
	const host = makeHost(makeRepo({ "a.txt": "bad", "b.txt": "ok", "two.test.mjs": TWO_CHECKS }));
	await host.on();
	const result = await host.call("delegate_implementation", { task: "change", profile: "medium", allowedPaths: ["b.txt"], implementationGuide: guide(["b.txt"], ["node --test two.test.mjs"]) });
	assert.equal(result.details.verification, "failed");
	assert.match(result.content[0].text, /the failure changed/);
	await assert.rejects(host.call("complete_task", { decision: "accept", summary: "The check was already failing before the change." }), /cannot be accepted/);
});

test("AUDIT-3: run_verification restores a task failed only by its checks, and fails it for a changed pre-existing failure", async () => {
	configure({ maxCorrectionRounds: 0 }, { "claude-sonnet-5": [{ write: { "value.txt": "bad" } }] });
	const repo = makeRepo({ "value.txt": "ok", "check.test.mjs": PASSING_CHECK });
	const host = makeHost(repo);
	await host.on();
	const first = await host.call("delegate_implementation", { task: "change", profile: "medium", allowedPaths: ["value.txt"], implementationGuide: guide(["value.txt"], ["node --test check.test.mjs"]) });
	assert.equal(first.details.verification, "failed");
	fs.writeFileSync(path.join(repo, "value.txt"), "ok");
	await host.call("run_verification", { command: "node --test check.test.mjs" });
	assert.deepEqual([host.ctx.auditState.taskPacket.phase, host.ctx.auditState.taskPacket.verification], ["implemented", "passed"]);

	const broken = `import test from "node:test";\nimport assert from "node:assert";\ntest("x", () => assert.fail("unrelated"));\n`;
	configure({}, { "claude-sonnet-5": [{ write: { "a.txt": "done" } }] });
	const redRepo = makeRepo({ "a.txt": "old", "broken.test.mjs": broken });
	const red = makeHost(redRepo);
	await red.on();
	await red.call("delegate_implementation", { task: "change", profile: "small", allowedPaths: ["a.txt"], implementationGuide: guide(["a.txt"], ["node --test broken.test.mjs"]) });
	assert.equal(red.ctx.auditState.taskPacket.phase, "implemented");
	fs.writeFileSync(path.join(redRepo, "broken.test.mjs"), broken.replace('"x"', '"y"'));
	const changed = await red.call("run_verification", { command: "node --test broken.test.mjs" });
	assert.match(changed.content[0].text, /the failure changed/);
	assert.deepEqual([red.ctx.auditState.taskPacket.phase, red.ctx.auditState.taskPacket.verification], ["failed", "failed"]);
});

test("AUDIT-3: a passing check records verification on an unverified task; a failed worker is never restored by a check", async () => {
	configure({}, { "claude-sonnet-5": [{ write: { "value.txt": "ok" } }] });
	const host = makeHost(makeRepo({ "value.txt": "old", "check.test.mjs": PASSING_CHECK }));
	await host.on();
	await host.call("delegate_implementation", { task: "change", profile: "small", allowedPaths: ["value.txt"], implementationGuide: guide(["value.txt"]) });
	assert.equal(host.ctx.auditState.taskPacket.verification, "unverified");
	await host.call("run_verification", { command: "node --test check.test.mjs" });
	assert.deepEqual([host.ctx.auditState.taskPacket.phase, host.ctx.auditState.taskPacket.verification], ["implemented", "passed"]);

	configure({}, { "claude-sonnet-5": [{ write: { "value.txt": "ok", "outside.txt": "x" } }] });
	const scoped = makeHost(makeRepo({ "value.txt": "old", "check.test.mjs": PASSING_CHECK }));
	await scoped.on();
	const violating = await scoped.call("delegate_implementation", { task: "change", profile: "small", allowedPaths: ["value.txt"], implementationGuide: guide(["value.txt"]) });
	assert.match(violating.content[0].text, /files outside allowedPaths changed: outside\.txt/);
	await scoped.call("run_verification", { command: "node --test check.test.mjs" });
	assert.equal(scoped.ctx.auditState.taskPacket.phase, "failed", "a scope violation is not cleared by passing checks");
});

test("AUDIT-3: files written by verification commands are reported, not counted as worker scope violations", async () => {
	const generating = `import test from "node:test";\nimport fs from "node:fs";\ntest("gen", () => fs.writeFileSync("generated.txt", String(Math.random())));\n`;
	configure({}, { "claude-sonnet-5": [{ write: { "a.txt": "done" } }] });
	const host = makeHost(makeRepo({ "a.txt": "old", "gen.test.mjs": generating }));
	await host.on();
	const result = await host.call("delegate_implementation", { task: "change", profile: "medium", allowedPaths: ["a.txt"], implementationGuide: guide(["a.txt"], ["node --test gen.test.mjs"]) });
	assert.equal(result.isError, false, result.content[0].text);
	assert.deepEqual(result.details.scopeViolations, []);
	assert.equal(result.details.verification, "passed");
	assert.ok(result.details.verificationChanged.includes("generated.txt"));
	assert.deepEqual(result.details.verificationSafetyViolations, [], "a written file is not a Git safety violation");
	assert.match(result.content[0].text, /verification commands changed files[^\n]*generated\.txt/);
	assert.equal(result.details.sessionPreserved, true);
});

test("AUDIT-3: a later delegation never re-baselines a red check whose failure an earlier delegation changed", async () => {
	configure({ maxCorrectionRounds: 0 }, { "claude-sonnet-5": [{ write: { "b.txt": "bad" } }, { write: { "other.txt": "x\n" } }] });
	const host = makeHost(makeRepo({ "a.txt": "bad", "b.txt": "ok", "two.test.mjs": TWO_CHECKS }));
	await host.on();
	const first = await host.call("delegate_implementation", { task: "change", profile: "medium", allowedPaths: ["b.txt"], implementationGuide: guide(["b.txt"], ["node --test two.test.mjs"]) });
	assert.equal(first.details.verification, "failed");
	await host.handlers.get("before_agent_start")({ prompt: "Go on" }, host.ctx);
	const second = await host.call("delegate_implementation", { task: "follow-up", profile: "medium", allowedPaths: ["other.txt"], implementationGuide: guide(["other.txt"], ["node --test two.test.mjs"]) });
	assert.equal(second.details.taskPacketId, first.details.taskPacketId);
	assert.equal(second.details.verification, "failed", "the failure is compared with the task start, not with this delegation's start");
	assert.match(second.content[0].text, /the failure changed/);
	await assert.rejects(host.call("complete_task", { decision: "accept", summary: "The check was already failing before the change." }), /cannot be accepted/);
});

test("AUDIT-3: fixing the added failure while the pre-existing one remains restores the task with unchanged failures", async () => {
	configure({ maxCorrectionRounds: 0 }, { "claude-sonnet-5": [{ write: { "b.txt": "bad" } }] });
	const repo = makeRepo({ "a.txt": "bad", "b.txt": "ok", "two.test.mjs": TWO_CHECKS });
	const host = makeHost(repo);
	await host.on();
	const result = await host.call("delegate_implementation", { task: "change", profile: "medium", allowedPaths: ["b.txt"], implementationGuide: guide(["b.txt"], ["node --test two.test.mjs"]) });
	assert.equal(result.details.verification, "failed");
	fs.writeFileSync(path.join(repo, "b.txt"), "ok");
	const check = await host.call("run_verification", { command: "node --test two.test.mjs" });
	assert.equal(check.details.state, "unchanged");
	assert.deepEqual([host.ctx.auditState.taskPacket.phase, host.ctx.auditState.taskPacket.verification], ["implemented", "unchanged_failures"]);
	const accepted = await host.call("complete_task", { decision: "accept", summary: "The added failure is fixed; test a was red before the task." });
	assert.equal(accepted.details.accepted, true);
});

test("AUDIT-3: a verification command that changes the Git index at the task start blocks the delegation before any worker", async () => {
	const stage = `import fs from "node:fs";\nimport { execFileSync } from "node:child_process";\nfs.writeFileSync("gen.txt", String(Math.random()));\nexecFileSync("git", ["add", "gen.txt"]);\n`;
	configure({}, { "claude-sonnet-5": [{ write: { "a.txt": "done" } }] });
	const repo = makeRepo({ "a.txt": "old", "stage.mjs": stage, "package.json": JSON.stringify({ scripts: { test: "node stage.mjs" } }) });
	const host = makeHost(repo);
	await host.on();
	const result = await host.call("delegate_implementation", { task: "change", profile: "medium", allowedPaths: ["a.txt"], implementationGuide: guide(["a.txt"], ["npm test"]) });
	assert.equal(result.isError, true);
	assert.deepEqual(calls(), [], "no worker starts on Git state a check changed");
	assert.equal(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "old");
	assert.equal(result.details.verification, "failed");
	assert.equal(result.details.sessionPreserved, false);
	assert.ok(result.details.verificationSafetyViolations.some((item: string) => /npm test: staged files or staged content changed/.test(item)), result.details.verificationSafetyViolations.join("; "));
	assert.match(result.content[0].text, /DELEGATION BLOCKED before any worker started[\s\S]*GIT SAFETY VIOLATION: npm test: staged/);
	assert.deepEqual([host.ctx.auditState.taskPacket.phase, host.ctx.auditState.taskPacket.verification], ["failed", "failed"]);
	assert.equal(host.ctx.auditState.workerSession, undefined);
	await assert.rejects(host.call("complete_task", { decision: "accept", summary: "The change itself is fine and reviewed." }), /cannot be accepted/);
});

test("AUDIT-3: a verification command that switches the branch at the task start is reported and blocks every worker", async () => {
	const branch = `import { execFileSync } from "node:child_process";\nexecFileSync("git", ["checkout", "-q", "-b", "verify-branch"]);\n`;
	configure({}, { "claude-sonnet-5": [{ write: { "a.txt": "done" } }] });
	const host = makeHost(makeRepo({ "a.txt": "old", "branch.mjs": branch, "package.json": JSON.stringify({ scripts: { test: "node branch.mjs" } }) }));
	await host.on();
	const result = await host.call("delegate_implementation", { task: "change", profile: "medium", allowedPaths: ["a.txt"], implementationGuide: guide(["a.txt"], ["npm test"]) });
	assert.equal(result.isError, true);
	assert.deepEqual(calls(), []);
	assert.ok(result.details.verificationSafetyViolations.some((item: string) => /^npm test: branch changed from \S+ to verify-branch$/.test(item)), result.details.verificationSafetyViolations.join("; "));
	assert.match(result.content[0].text, /branch changed from \S+ to verify-branch/);
});

test("AUDIT-3: a check that moves HEAD after the worker fails the delegation without a correction round or a kept session", async () => {
	const commit = `import fs from "node:fs";\nimport { execFileSync } from "node:child_process";\nif (fs.readFileSync("value.txt", "utf8") === "bad") {\n\texecFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "made by a check"]);\n\tprocess.exit(1);\n}\n`;
	configure({}, { "claude-sonnet-5": [{ write: { "value.txt": "bad" } }, { write: { "value.txt": "ok" } }] });
	const host = makeHost(makeRepo({ "value.txt": "ok", "commit.mjs": commit, "package.json": JSON.stringify({ scripts: { test: "node commit.mjs" } }) }));
	await host.on();
	const result = await host.call("delegate_implementation", { task: "change", profile: "medium", allowedPaths: ["value.txt"], implementationGuide: guide(["value.txt"], ["npm test"]) });
	assert.equal(result.isError, true);
	assert.equal(calls().length, 1, "the failing check would normally start a correction round");
	assert.equal(result.details.correctionRounds, 0);
	assert.equal(result.details.verification, "failed");
	assert.equal(result.details.sessionPreserved, false);
	assert.deepEqual(result.details.scopeViolations, [], "the worker itself did not move HEAD");
	assert.ok(result.details.verificationSafetyViolations.some((item: string) => /^npm test: HEAD changed from /.test(item)), result.details.verificationSafetyViolations.join("; "));
	assert.match(result.content[0].text, /GIT SAFETY VIOLATION by verification commands[^\n]*Automation stopped/);
	assert.equal(host.ctx.auditState.workerSession, undefined);
	await assert.rejects(host.call("complete_task", { decision: "accept", summary: "The change itself is fine and reviewed." }), /cannot be accepted/);
});

test("AUDIT-3: after a check switches the branch, later VERIFY commands do not run and are not reported as run", async () => {
	const branch = `import fs from "node:fs";\nimport { execFileSync } from "node:child_process";\nif (fs.readFileSync("value.txt", "utf8") === "bad") execFileSync("git", ["checkout", "-q", "-b", "verify-branch"]);\n`;
	const sentinel = `import fs from "node:fs";\nif (fs.readFileSync("value.txt", "utf8") === "bad") fs.writeFileSync("sentinel.txt", "ran");\n`;
	configure({}, { "claude-sonnet-5": [{ write: { "value.txt": "bad" } }, { write: { "value.txt": "ok" } }] });
	const repo = makeRepo({ "value.txt": "ok", "branch.mjs": branch, "sentinel.mjs": sentinel, "package.json": JSON.stringify({ scripts: { test: "node branch.mjs", lint: "node sentinel.mjs" } }) });
	const host = makeHost(repo);
	await host.on();
	const result = await host.call("delegate_implementation", { task: "change", profile: "medium", allowedPaths: ["value.txt"], implementationGuide: guide(["value.txt"], ["npm test", "npm run lint"]) });
	assert.equal(result.isError, true);
	assert.equal(fs.existsSync(path.join(repo, "sentinel.txt")), false, "no later check runs on the changed Git state");
	assert.equal(calls().length, 1, "no correction round either");
	assert.deepEqual(result.details.verificationCommandsRun, ["npm test"]);
	assert.ok(result.details.verificationSafetyViolations.some((item: string) => /^npm test: branch changed from \S+ to verify-branch$/.test(item)), result.details.verificationSafetyViolations.join("; "));
	const text = result.content[0].text;
	assert.match(text, /^- npm test: pass — GIT SAFETY VIOLATION: branch changed/m);
	assert.doesNotMatch(text, /^- npm run lint:/m);
	assert.match(text, /already run by the extension on the final code: npm test\. /);
	assert.match(text, /Not run on the changed Git state: npm run lint\./);
});

test("AUDIT-3: a manual check that changes the Git index ends the worker session: no continuation on that state", async () => {
	const stage = `import fs from "node:fs";\nimport { execFileSync } from "node:child_process";\nfs.writeFileSync("gen.txt", String(Math.random()));\nexecFileSync("git", ["add", "gen.txt"]);\n`;
	configure({}, { "claude-sonnet-5": [{ write: { "a.txt": "done" } }, { write: { "a.txt": "again" } }] });
	const host = makeHost(makeRepo({ "a.txt": "old", "stage.mjs": stage, "package.json": JSON.stringify({ scripts: { test: "node stage.mjs" } }) }));
	await host.on();
	const result = await host.call("delegate_implementation", { task: "change", profile: "medium", allowedPaths: ["a.txt"], implementationGuide: guide(["a.txt"]) });
	assert.equal(result.details.sessionPreserved, true);
	assert.ok(host.ctx.auditState.workerSession);
	const check = await host.call("run_verification", { command: "npm test" });
	assert.equal(check.isError, true);
	assert.match(check.content[0].text, /GIT SAFETY VIOLATION: staged files or staged content changed/);
	assert.equal(host.ctx.auditState.workerSession, undefined, "the cleared session is persisted");
	assert.deepEqual([host.ctx.auditState.taskPacket.phase, host.ctx.auditState.taskPacket.verification], ["failed", "failed"]);
	await assert.rejects(host.call("delegate_implementation", { task: "finish", continuePrevious: true, allowedPaths: ["a.txt"], implementationGuide: guide(["a.txt"]) }), /Cannot continue/);
	assert.equal(calls().length, 1, "no worker was resumed");
});

test("AUDIT-3: planning, commit and push are rejected while a delegation is running", async () => {
	configure({ workerCommandArgs: [scriptedClaude("slow-claude-3", 'if (step.action === "slow") { await new Promise((resolve) => setTimeout(resolve, 1500)); }')] }, { "claude-sonnet-5": [{ action: "slow", write: { "a.txt": "done" } }] });
	const host = makeHost(makeRepo({ "a.txt": "old" }));
	await host.on();
	const running = host.call("delegate_implementation", { task: "change", profile: "medium", allowedPaths: ["a.txt"], implementationGuide: guide(["a.txt"]) });
	await assert.rejects(host.call("plan_task", { task: "another task", profile: "small", rationale: "test" }), /running delegation/);
	await assert.rejects(host.call("request_git_commit", { message: "wip", paths: ["a.txt"] }), /running delegation/);
	await assert.rejects(host.call("request_git_push", {}), /running delegation/);
	const result = await running;
	assert.equal(result.isError, false, result.content[0].text);
	assert.equal(host.ctx.auditState.taskPacket.phase, "implemented");
});

test("the worker chain is reported in chain order, skipped candidates included", async () => {
	// First delegation: GPT runs out of credits and Sonnet takes over. Its account is now blocked.
	configure({}, { "gpt-5.5": [{ action: "credits" }], "claude-sonnet-5": [{ write: { "a.txt": "done" } }, { write: { "a.txt": "again" } }] });
	const host = makeHost(makeRepo({ "a.txt": "old" }));
	await host.on();
	await host.call("delegate_implementation", { task: "first", profile: "medium", preferWorker: "gpt", allowedPaths: ["a.txt"], implementationGuide: guide(["a.txt"]) });
	// Second delegation: Sonnet (first in the chain) works, GPT (second) is skipped; the report keeps that order.
	const result = await host.call("delegate_implementation", { task: "second", profile: "medium", allowedPaths: ["a.txt"], implementationGuide: guide(["a.txt"]) });
	const chain = /Worker chain: (.*)/.exec(result.content[0].text)?.[1] ?? "";
	assert.ok(chain.indexOf("claude-sonnet-5") >= 0 && chain.indexOf("claude-sonnet-5") < chain.indexOf("gpt-5.5"), chain);
});

const RED_CHECK = `import test from "node:test";\nimport assert from "node:assert";\nimport fs from "node:fs";\ntest("broken", () => assert.equal(fs.readFileSync("a.txt", "utf8"), "ok"));\n`;

test("CONTEXT: passing tests added by the worker keep a pre-existing failure unchanged; later delegations only name it", async () => {
	const withNewTest = RED_CHECK.replace('test("broken"', 'test("added by the worker", () => assert.ok(true));\ntest("broken"');
	configure({ maxCorrectionRounds: 0 }, { "claude-sonnet-5": [{ write: { "red.test.mjs": withNewTest } }, { write: { "b.txt": "two" } }] });
	const host = makeHost(makeRepo({ "a.txt": "bad", "b.txt": "one", "red.test.mjs": RED_CHECK }));
	await host.on();
	const verify = ["node --test --test-reporter=tap red.test.mjs"];
	const first = await host.call("delegate_implementation", { task: "add a test", profile: "medium", allowedPaths: ["red.test.mjs", "b.txt"], implementationGuide: guide(["red.test.mjs", "b.txt"], verify) });
	assert.equal(first.details.verification, "unchanged_failures", first.content[0].text);
	assert.match(first.content[0].text, /\$ node --test/, "the first delegation shows what the pre-existing failure is");
	const second = await host.call("delegate_implementation", { task: "next step", profile: "medium", continuePrevious: true, allowedPaths: ["red.test.mjs", "b.txt"], implementationGuide: guide(["red.test.mjs", "b.txt"], verify) });
	assert.equal(second.details.verification, "unchanged_failures", second.content[0].text);
	assert.match(second.content[0].text, /already failing before this task, in the same way/);
	assert.doesNotMatch(second.content[0].text, /\$ node --test/, "a later delegation does not repeat its output");
});

test("CONTEXT: run_verification returns a short tail for a passing check and a longer one for a failing check", async () => {
	configure({}, {});
	const noisy = (ok: boolean) => `import test from "node:test";\nimport assert from "node:assert";\ntest("noisy", () => { console.log("x".repeat(30000)); assert.ok(${ok}); });\n`;
	const repo = makeRepo({ "pass.test.mjs": noisy(true), "fail.test.mjs": noisy(false) });
	const host = makeHost(repo);
	await host.on();
	const pass = (await host.call("run_verification", { command: "node --test pass.test.mjs" })).content[0].text;
	assert.match(pass, /exit code 0/);
	assert.ok(Buffer.byteLength(pass) < 2400, `passing output is ${Buffer.byteLength(pass)} bytes`);
	const fail = (await host.call("run_verification", { command: "node --test fail.test.mjs" })).content[0].text;
	assert.match(fail, /exit code 1/);
	assert.ok(Buffer.byteLength(fail) > 10_000 && Buffer.byteLength(fail) < 12_400, `failing output is ${Buffer.byteLength(fail)} bytes`);
});

test("CONTEXT: a long worker report is shortened in the middle and never pushes the review or the diff out", async () => {
	const report = `Summary start.\n${"detail line\n".repeat(5000)}RESIDUAL RISKS: end-marker`;
	configure({ independentReviewProfiles: ["medium"], reviewApi: baseConfig.reviewApi }, { "claude-sonnet-5": [{ write: { "a.txt": "done\n" }, text: report }] });
	const host = makeHost(makeRepo({ "a.txt": "old\n" }));
	await host.on();
	const result = await host.call("delegate_implementation", { task: "change", profile: "medium", allowedPaths: ["a.txt"], implementationGuide: guide(["a.txt"]) });
	const text = result.content[0].text;
	assert.match(text, /Summary start\./);
	assert.match(text, /end-marker/);
	assert.match(text, /middle omitted/);
	assert.match(text, /verdict PASS/);
	assert.match(text, /DIFF \(this delegation only\)/);
	assert.ok(Buffer.byteLength(text) < 16_000, `result is ${Buffer.byteLength(text)} bytes`);
});

test("CONTEXT: outputLimits are validated", async () => {
	configure({ outputLimits: { consultBytes: 10 } }, {});
	assert.throws(() => makeHost(makeRepo({ "a.txt": "old" })), /outputLimits\.consultBytes/);
});

test("REUSE: the next delegation of the same prompt reuses the checks that closed the previous one, on the same code only", async () => {
	configure({}, { "claude-sonnet-5": [{ write: { "value.txt": "ok" } }, { write: { "b.txt": "1" } }, { write: { "b.txt": "2" } }, { write: { "b.txt": "3" } }] });
	const repo = makeRepo({ "value.txt": "bad", "b.txt": "0", "check.test.mjs": PASSING_CHECK });
	const host = makeHost(repo);
	await host.on();
	const verify = ["node --test check.test.mjs"];
	const delegate = (task: string) => host.call("delegate_implementation", { task, profile: "medium", allowedPaths: ["value.txt", "b.txt"], implementationGuide: guide(["value.txt", "b.txt"], verify) });
	const first = await delegate("fix");
	assert.equal(first.details.verification, "passed", first.content[0].text);
	assert.deepEqual(first.details.checksReusedAtStart, []);
	const second = await delegate("next step");
	assert.deepEqual(second.details.checksReusedAtStart, verify, "same code as the checks that closed the first delegation");
	assert.equal(second.details.verification, "passed");
	fs.writeFileSync(path.join(repo, "value.txt"), "bad");
	fs.writeFileSync(path.join(repo, "value.txt"), "ok");
	fs.writeFileSync(path.join(repo, "untracked.txt"), "new");
	const third = await delegate("third step");
	assert.deepEqual(third.details.checksReusedAtStart, [], "an untracked file changed the repository state");
	await host.handlers.get("before_agent_start")({ prompt: "Go on" }, host.ctx);
	const fourth = await delegate("fourth step");
	assert.deepEqual(fourth.details.checksReusedAtStart, [], "a new user prompt never reuses results");
	await host.command("status");
	assert.match(host.notifications.at(-1)!, /reused 1\b/);
});

test("REUSE: a reused red check keeps its failure signature, so a changed failure is still a regression", async () => {
	configure({ maxCorrectionRounds: 0 }, { "claude-sonnet-5": [{ write: { "b.txt": "bad" } }, { write: { "other.txt": "x\n" } }] });
	const host = makeHost(makeRepo({ "a.txt": "bad", "b.txt": "ok", "two.test.mjs": TWO_CHECKS }));
	await host.on();
	const verify = ["node --test two.test.mjs"];
	const first = await host.call("delegate_implementation", { task: "change", profile: "medium", allowedPaths: ["b.txt"], implementationGuide: guide(["b.txt"], verify) });
	assert.equal(first.details.verification, "failed");
	const second = await host.call("delegate_implementation", { task: "follow-up", profile: "medium", allowedPaths: ["other.txt"], implementationGuide: guide(["other.txt"], verify) });
	assert.deepEqual(second.details.checksReusedAtStart, verify);
	assert.equal(second.details.verification, "failed");
	assert.match(second.content[0].text, /the failure changed/);
});

test("REUSE: reuseChecks false, or a supervisor with a shell, always runs the checks again", async () => {
	for (const overrides of [{ reuseChecks: false }, { supervisorTools: [...baseConfig.supervisorTools, "bash"] }]) {
		configure(overrides, { "claude-sonnet-5": [{ write: { "value.txt": "ok" } }, { write: { "b.txt": "1" } }] });
		const host = makeHost(makeRepo({ "value.txt": "bad", "b.txt": "0", "check.test.mjs": PASSING_CHECK }));
		await host.on();
		const verify = ["node --test check.test.mjs"];
		await host.call("delegate_implementation", { task: "fix", profile: "medium", allowedPaths: ["value.txt", "b.txt"], implementationGuide: guide(["value.txt", "b.txt"], verify) });
		const second = await host.call("delegate_implementation", { task: "next", profile: "medium", allowedPaths: ["value.txt", "b.txt"], implementationGuide: guide(["value.txt", "b.txt"], verify) });
		assert.deepEqual(second.details.checksReusedAtStart, [], JSON.stringify(overrides));
	}
});

test("OUTLINE: code_outline lists declarations with line ranges, expands directories without ignored files, stays in the workspace", async () => {
	configure({}, {});
	const repo = makeRepo({
		".gitignore": "src/gen/\n",
		"src/store.ts": "export class Store {\n\tadd(item: string): void {\n\t\tconsole.log(item);\n\t}\n}\n",
		"src/gen/out.ts": "export function generated() {}\n",
		"src/data.json": "{}\n",
		"README.md": "# Title\n\n## Use\n",
	});
	const host = makeHost(repo);
	await host.on();
	const text = (await host.call("code_outline", { paths: ["src", "README.md", "missing.ts"] })).content[0].text;
	assert.match(text, /^src\/store\.ts \(5 lines\)$/m);
	assert.match(text, /1-5 +export class Store/);
	assert.match(text, /2-4 +add\(item: string\): void/);
	assert.match(text, /## Use/);
	assert.match(text, /missing\.ts: not found/);
	assert.doesNotMatch(text, /generated|data\.json/);
	await assert.rejects(host.call("code_outline", { paths: ["../outside"] }), /'\.\.'/);
});

test("OUTLINE: code_outline references list the uses of a symbol with their enclosing function, Git-ignored files excluded", async () => {
	configure({}, {});
	const repo = makeRepo({
		".gitignore": "gen/\n",
		"src/store.ts": "export class Store {\n\tadd(item: string): void {\n\t\tconsole.log(item);\n\t}\n}\n",
		"src/app.ts": "import { Store } from \"./store.ts\";\n\nexport function main() {\n\tnew Store().add(\"x\");\n}\n",
		"gen/copy.ts": "new Store().add(\"y\");\n",
	});
	fs.writeFileSync(path.join(repo, "src", "extra.ts"), "export const run = () => {\n\tnew Store().add(\"z\");\n};\n");
	const host = makeHost(repo);
	await host.on();
	const text = (await host.call("code_outline", { references: ["Store.add"] })).content[0].text;
	assert.match(text, /^Store\.add: 3 references in 3 files$/m);
	assert.match(text, /src\/app\.ts\n +4 {2}in main: new Store\(\)\.add\("x"\);/);
	assert.match(text, /src\/extra\.ts\n +2 {2}in run: /, "untracked files are searched");
	assert.match(text, /src\/store\.ts\n +2 {2}declaration: add\(item: string\): void \{/);
	assert.doesNotMatch(text, /gen\/copy\.ts/);
	const scoped = (await host.call("code_outline", { references: ["Store"], paths: ["src/app.ts"] })).content[0].text;
	assert.match(scoped, /^Store: 2 references in 1 file$/m);
	await assert.rejects(host.call("code_outline", { references: ["--open-files-in-pager"] }), /Not a symbol name/);
	await assert.rejects(host.call("code_outline", {}), /needs paths/);
});
