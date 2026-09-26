// Stand-in for the Claude Code CLI in --print --output-format stream-json mode (format captured from CLI 2.1.281).
// Behavior per model comes from a queue in FAKE_PLAN (JSON file); every call is appended to FAKE_LOG.
import * as fs from "node:fs";
import * as path from "node:path";

const args = process.argv.slice(2);
const option = (name) => {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : undefined;
};
const model = option("--model") ?? "unknown";
const resume = option("--resume");
const prompt = fs.readFileSync(0, "utf8");
const planFile = process.env.FAKE_PLAN;
const plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
const step = (plan[model] ?? []).shift() ?? { action: "text", text: "Nothing scripted for this model." };
fs.writeFileSync(planFile, JSON.stringify(plan));
const sessionId = resume ?? `sess-${model}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
fs.appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ cli: "claude", model, effort: option("--effort"), maxTurns: option("--max-turns"), resume, mode: option("--permission-mode"), tools: option("--tools"), allowedTools: option("--allowedTools"), prompt })}\n`);

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
emit({ type: "system", subtype: "init", model, session_id: sessionId });
for (const [file, content] of Object.entries(step.write ?? {})) {
	fs.mkdirSync(path.dirname(path.join(process.cwd(), file)), { recursive: true });
	fs.writeFileSync(path.join(process.cwd(), file), content);
}
const usage = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
if (step.action === "credits") {
	emit({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: Math.floor(Date.now() / 1000) + 3600, errorCode: "credits_required" }, session_id: sessionId });
	emit({ type: "assistant", error: "rate_limit", message: { model: "<synthetic>", content: [{ type: "text", text: `${model} requires usage credits.` }] }, session_id: sessionId });
	emit({ type: "result", subtype: "success", is_error: true, result: `${model} requires usage credits.`, api_error_status: 429, session_id: sessionId, total_cost_usd: 0, usage });
	process.exit(1);
}
emit({ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour", unifiedWindows: { five_hour: { utilization: 0.2, resetsAt: Math.floor(Date.now() / 1000) + 3600 } } }, session_id: sessionId });
const text = step.text ?? `Changed files: ${Object.keys(step.write ?? {}).join(", ") || "none"}.`;
emit({ type: "assistant", message: { model, content: [{ type: "text", text }] }, session_id: sessionId });
emit({ type: "result", subtype: "success", is_error: false, result: text, num_turns: 1, session_id: sessionId, total_cost_usd: 0.01, usage });
