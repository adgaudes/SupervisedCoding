import assert from "node:assert/strict";
import { test } from "node:test";
import { planContextEdits, PRUNED_MARK, type ProjectedEntry } from "../pruning.ts";

let counter = 0;
const big = (label: string, bytes = 5000) => `${label}\n${"x".repeat(bytes)}`;
const user = (text: string): ProjectedEntry => ({ sourceEntry: { id: `e${++counter}`, type: "message" }, messages: [{ role: "user", content: text }] });
const call = (id: string, name: string, args: Record<string, unknown>): ProjectedEntry => ({ sourceEntry: { id: `e${++counter}`, type: "message" }, messages: [{ role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] }] });
const result = (id: string, toolName: string, text: string, details?: unknown): ProjectedEntry => ({ sourceEntry: { id: `r-${id}`, type: "message" }, messages: [{ role: "toolResult", toolCallId: id, toolName, content: [{ type: "text", text }], details, isError: false }] });

function session(): ProjectedEntry[] {
	return [
		user("unrelated earlier question"),
		call("c0", "read", { path: "docs/guide.md" }), result("c0", "read", big("guide")),
		user("fix the bug in src/a.ts"),
		call("c1", "read", { path: "src/a.ts", offset: 10, limit: 80 }), result("c1", "read", big("a.ts before")),
		call("c2", "grep", { pattern: "total" }), result("c2", "grep", big("grep hits")),
		call("c3", "delegate_implementation", {}), result("c3", "delegate_implementation", `Claude sonnet (medium) completed.\nChanged files in this delegation: src/a.ts\nAutomatic verification: passed\n\n${big("worker report and diff")}`, { taskPacketId: "T1", changedFiles: ["src/a.ts"] }),
		call("c4", "complete_task", { decision: "accept" }), result("c4", "complete_task", "Task accepted and completed.", { taskId: "T1", accepted: true }),
	];
}

test("results of an accepted task become short notes; the rest of the session is untouched", () => {
	const { edits, savedBytes } = planContextEdits(session(), { cwd: "/repo", minResultBytes: 1500, minTotalBytes: 1000 });
	const byId = new Map(edits.map((edit) => [edit.targetId, edit.replacement.content[0].text]));
	assert.deepEqual([...byId.keys()].sort(), ["r-c1", "r-c2", "r-c3"]);
	assert.match(byId.get("r-c1")!, /^\[pruned\] Outdated read of src\/a\.ts \(offset 10, limit 80\): a later delegation changed this file/);
	assert.match(byId.get("r-c2")!, /^\[pruned\] grep \{"pattern":"total"\} output omitted/);
	const delegation = byId.get("r-c3")!;
	assert.match(delegation, /^Claude sonnet \(medium\) completed\.\nChanged files in this delegation: src\/a\.ts\nAutomatic verification: passed\n\[pruned\]/);
	assert.doesNotMatch(delegation, /worker report/);
	assert.ok(savedBytes > 12_000);
});

test("nothing is edited while the saving is below minTotalBytes, and a task still open keeps its results", () => {
	assert.deepEqual(planContextEdits(session(), { cwd: "/repo", minResultBytes: 1500, minTotalBytes: 100_000 }), { edits: [], savedBytes: 0 });
	const open = session().slice(0, -2);
	const { edits } = planContextEdits(open, { cwd: "/repo", minResultBytes: 1500, minTotalBytes: 1000 });
	assert.deepEqual(edits.map((edit) => edit.targetId), ["r-c1"], "only the outdated read of the changed file");
});

test("an already pruned result is not edited again, and a read of this very file is not mistaken for one", () => {
	const entries = session();
	const first = planContextEdits(entries, { cwd: "/repo", minResultBytes: 1500, minTotalBytes: 1000 }).edits;
	const applied = entries.map((entry) => {
		const edit = first.find((item) => item.targetId === entry.sourceEntry.id);
		return edit ? { ...entry, messages: [{ ...entry.messages[0], content: edit.replacement.content }] } : entry;
	});
	assert.deepEqual(planContextEdits(applied, { cwd: "/repo", minResultBytes: 1500, minTotalBytes: 0 }).edits, []);
	const mentions = [user("go"), call("m1", "read", { path: "pruning.ts" }), result("m1", "read", big(`const PRUNED_MARK = "${PRUNED_MARK}";`)), call("m2", "delegate_implementation", {}), result("m2", "delegate_implementation", "done", { changedFiles: ["pruning.ts"] })];
	assert.deepEqual(planContextEdits(mentions, { cwd: "/repo", minResultBytes: 1500, minTotalBytes: 0 }).edits.map((edit) => edit.targetId), ["r-m1"]);
});

test("absolute read paths match the delegation's relative changed files", () => {
	const cwd = process.platform === "win32" ? "C:\\repo" : "/repo";
	const absolute = process.platform === "win32" ? "C:\\repo\\src\\B.ts" : "/repo/src/b.ts";
	const entries = [user("go"), call("a1", "read", { path: absolute }), result("a1", "read", big("b")), call("a2", "delegate_implementation", {}), result("a2", "delegate_implementation", "Changed files in this delegation: src/b.ts\n\nrest")];
	assert.deepEqual(planContextEdits(entries, { cwd, minResultBytes: 1500, minTotalBytes: 0 }).edits.map((edit) => edit.targetId), ["r-a1"]);
});
