// Stand-in for the Gemini CLI in --output-format json mode. Same FAKE_PLAN / FAKE_LOG protocol as fake-claude.mjs.
import * as fs from "node:fs";
import * as path from "node:path";

const args = process.argv.slice(2);
const index = args.indexOf("--model");
const model = index >= 0 ? args[index + 1] : "gemini-default";
const prompt = fs.readFileSync(0, "utf8");
const planFile = process.env.FAKE_PLAN;
const plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
const step = (plan[model] ?? []).shift() ?? { action: "text", text: "Nothing scripted for this model." };
fs.writeFileSync(planFile, JSON.stringify(plan));
fs.appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ cli: "gemini", model, mode: args[args.indexOf("--approval-mode") + 1], prompt })}\n`);
for (const [file, content] of Object.entries(step.write ?? {})) {
	fs.mkdirSync(path.dirname(path.join(process.cwd(), file)), { recursive: true });
	fs.writeFileSync(path.join(process.cwd(), file), content);
}
const stats = { models: { [model]: { tokens: { input: 1000, candidates: 50, thoughts: 10, cached: 0 } } } };
if (step.action === "quota") {
	process.stdout.write(JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded for metric generate_content_requests" } }));
	process.exit(1);
}
process.stdout.write(JSON.stringify({ response: step.text ?? "Done.", stats, session_id: "gemini-session" }));
