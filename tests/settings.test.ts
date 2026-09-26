// Personal settings: <agent-dir>/supervised-coding/config.json overrides the packaged defaults, merged one level deep,
// so a package update never overwrites them. Runs the real extension with PI_CODING_AGENT_DIR pointing at a scratch dir.
// Run: node --import ./tests/resolve-pi.mjs --test tests/settings.test.ts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// The extension compares paths as text (Git root against cwd and the authorized paths), and Git always reports
// the real path. A temp root that is a short name or a symlink (C:\Users\RUNNER~1 on the Windows CI runners,
// /tmp on macOS) would therefore not match, so the harness resolves it once here, as Pi gives a real cwd.
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "supervised-coding-settings-")));
const agentDir = path.join(root, "agent");
const userDir = path.join(agentDir, "supervised-coding");
const planFile = path.join(root, "plan.json");
const logFile = path.join(root, "calls.jsonl");
fs.mkdirSync(userDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
delete process.env.SUPERVISED_CODING_CONFIG;
delete process.env.SUPERVISED_CODING_DATA;
process.env.FAKE_PLAN = planFile;
process.env.FAKE_LOG = logFile;
fs.writeFileSync(path.join(userDir, "config.json"), JSON.stringify({
	workerCommand: process.execPath,
	workerCommandArgs: [path.join(here, "fakes", "fake-claude.mjs")],
	piCommand: process.execPath,
	piCommandArgs: [path.join(here, "fakes", "fake-pi.mjs")],
	supervisorChain: [],
	probeOnActivate: false,
	reviewApi: null,
	independentReviewProfiles: [],
	// One profile only: the other profiles keep the packaged defaults.
	workerChains: { medium: [{ worker: "claude", model: "personal-model", effort: "high" }] },
}));
fs.writeFileSync(planFile, JSON.stringify({ "personal-model": [{ write: { "a.txt": "done" } }] }));
fs.writeFileSync(logFile, "");
const { default: extension } = await import("../index.ts");
const defaults = JSON.parse(fs.readFileSync(path.join(here, "..", "config.json"), "utf8"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

function makeRepo(): string {
	const repo = fs.mkdtempSync(path.join(root, "repo-"));
	fs.writeFileSync(path.join(repo, "a.txt"), "old");
	const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
	git("init", "-q");
	git("add", "-A");
	git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init");
	return repo;
}

test("personal settings override the defaults one level deep, and data stays outside the package", async () => {
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const notifications: string[] = [];
	let activeTools = ["read"];
	const ctx: any = {
		cwd: makeRepo(),
		hasUI: false,
		model: { provider: "test", id: "supervisor" },
		modelRegistry: { find: () => undefined, hasConfiguredAuth: () => false, isUsingOAuth: () => false },
		ui: { notify: (text: string) => notifications.push(text), setStatus: () => undefined, theme: { fg: (_: string, text: string) => text } },
		getContextUsage: () => undefined,
		sessionManager: { getBranch: () => [] },
	};
	extension({
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		on: () => undefined,
		appendEntry: () => undefined,
		getActiveTools: () => activeTools,
		setActiveTools: (names: string[]) => { activeTools = names; },
		setModel: async () => true,
		getThinkingLevel: () => "medium",
		setThinkingLevel: () => undefined,
		sendMessage: () => undefined,
	} as any);
	await commands.get("SupervisedCoding").handler("on", ctx);
	const call = (name: string, params: any) => tools.get(name).execute("t", params, undefined, undefined, ctx);
	const guide = "FILE: a.txt\nSYMBOLS: none\nCHANGES:\n- Apply the scripted change; this guide is padded to exceed the four hundred characters that the medium profile requires before any worker may start, so the delegation is accepted by the extension.\nPRESERVE:\n- Everything else in the repository, which this test never touches: other files, the Git history and the index.\nVERIFY:\n- Read the file back and confirm its new content.";
	const result = await call("delegate_implementation", { task: "change", profile: "medium", allowedPaths: ["a.txt"], implementationGuide: guide });
	assert.equal(result.isError, false, result.content[0].text);
	const calls = fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
	assert.deepEqual(calls.map((item) => item.model), ["personal-model"], "the personal medium chain");
	const planned = await call("plan_task", { task: "small one", profile: "small", rationale: "test" });
	assert.match(planned.content[0].text, new RegExp(`Worker chain: Claude ${defaults.workerChains.small[0].model}`), "other profiles keep the packaged defaults");
	const learning = JSON.parse(fs.readFileSync(path.join(userDir, "learning.json"), "utf8")) as { outcomes: Array<{ model: string }> };
	assert.ok(learning.outcomes.some((item) => item.model === "personal-model"), "this delegation's outcome is in the agent directory");
	assert.ok(fs.existsSync(path.join(userDir, "usage.jsonl")), "usage log in the agent directory");
	await commands.get("SupervisedCoding").handler("status", ctx);
	assert.match(notifications.at(-1)!, /personal settings/);
});
