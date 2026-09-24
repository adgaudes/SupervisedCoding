// Stand-in for Pi's CLI in --mode json (event shapes from Pi 0.87.1 docs/json.md). Same FAKE_PLAN / FAKE_LOG
// protocol as fake-claude.mjs; the plan is keyed by model id without the provider.
import * as fs from "node:fs";
import * as path from "node:path";

const args = process.argv.slice(2);
const option = (name) => {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : undefined;
};
const [provider, model] = (option("--model") ?? "unknown/unknown").split("/");
const sessionId = option("--session-id") ?? "no-session";
const prompt = fs.readFileSync(0, "utf8");
const planFile = process.env.FAKE_PLAN;
const plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
const step = (plan[model] ?? []).shift() ?? { action: "text", text: "Nothing scripted for this model." };
fs.writeFileSync(planFile, JSON.stringify(plan));
fs.appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ cli: "pi", provider, model, effort: option("--thinking"), resume: sessionId, tools: option("--tools"), extensions: !args.includes("--no-extensions"), prompt })}\n`);

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const usage = { input: 200, output: 30, cacheRead: 0, cacheWrite: 0, totalTokens: 230, cost: { input: 0.001, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.002 } };
const assistant = (text, stopReason = "stop", errorMessage) => ({ role: "assistant", content: text ? [{ type: "text", text }] : [], provider, model, usage, stopReason, ...(errorMessage ? { errorMessage } : {}) });

emit({ type: "session", version: 3, id: sessionId, cwd: process.cwd() });
emit({ type: "agent_start" });
if (step.action === "turns") {
	// A worker that keeps working: the extension must stop it at its turn limit.
	for (let turn = 0; turn < 500; turn++) emit({ type: "turn_start" });
	await new Promise((resolve) => setTimeout(resolve, 30_000));
}
emit({ type: "turn_start" });
for (const [file, content] of Object.entries(step.write ?? {})) {
	fs.mkdirSync(path.dirname(path.join(process.cwd(), file)), { recursive: true });
	fs.writeFileSync(path.join(process.cwd(), file), content);
}
if (step.action === "credits") {
	emit({ type: "message_end", message: assistant("", "error", "You have exceeded your usage limit for this plan (quota).") });
} else {
	emit({ type: "message_end", message: assistant(step.text ?? `Changed files: ${Object.keys(step.write ?? {}).join(", ") || "none"}.`) });
}
emit({ type: "turn_end" });
emit({ type: "agent_end", messages: [], willRetry: false });
emit({ type: "agent_settled" });
