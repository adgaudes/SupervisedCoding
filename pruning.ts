/**
 * Supervisor context pruning. Every tool result stays in the supervisor's context and is resent on every later
 * turn. Once a task is accepted, the bulky results that served it (file reads, searches, outlines, delegation
 * reports, reviews) are replaced with one-line notes; a file read that a later delegation changed is marked as
 * outdated, so the supervisor never reasons on old code. Pi applies the replacements as context edits: the session
 * history is unchanged, only what the model sees. Pure function: the caller decides when to apply the edits.
 */
import * as path from "node:path";

export interface ProjectedEntry {
	sourceEntry: { id: string; type: string; message?: any };
	/** Model-visible messages after earlier context edits (empty when omitted). */
	messages: any[];
}

export interface ContextEditDraft {
	type: "context_edit";
	targetId: string;
	replacement: { content: Array<{ type: "text"; text: string }> };
}

export interface PruneOptions {
	cwd: string;
	/** Results of accepted tasks smaller than this stay as they are. */
	minResultBytes: number;
	/** Edits are proposed only when they save at least this much: each batch invalidates the prompt cache once. */
	minTotalBytes: number;
}

export const PRUNED_MARK = "[pruned]";

/** Tools whose first output line summarizes the result (reviewer and verdict, command and outcome). */
const SUMMARY_FIRST_LINE = new Set(["consult_readonly", "review_changes", "run_verification", "plan_task"]);

interface ToolResult {
	index: number;
	id: string;
	toolName: string;
	args: Record<string, any>;
	details: any;
	text: string;
	bytes: number;
}

function contentBytes(content: unknown): number {
	if (typeof content === "string") return Buffer.byteLength(content, "utf8");
	if (!Array.isArray(content)) return 0;
	return content.reduce((sum: number, part: any) => sum + (part?.type === "text" ? Buffer.byteLength(String(part.text ?? ""), "utf8") : typeof part?.data === "string" ? part.data.length : 0), 0);
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	return Array.isArray(content) ? content.filter((part: any) => part?.type === "text").map((part: any) => String(part.text ?? "")).join("\n") : "";
}

function normalizePath(cwd: string, value: unknown): string | undefined {
	if (typeof value !== "string" || !value.trim()) return undefined;
	const relative = path.isAbsolute(value) ? path.relative(cwd, value) : value;
	const normalized = relative.replace(/\\/g, "/").replace(/^\.\//, "");
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** Files a delegation result reports as changed: its details, or the line of older results. */
function changedFiles(result: ToolResult, cwd: string): string[] {
	const listed: unknown = result.details?.changedFiles;
	const files = Array.isArray(listed) ? listed : (/^Changed files in this delegation: (.*)$/m.exec(result.text)?.[1] ?? "").split(",").map((item) => item.trim()).filter((item) => item && item !== "none");
	return files.map((file) => normalizePath(cwd, file)).filter((file): file is string => Boolean(file));
}

function firstLine(text: string, maxChars = 240): string {
	const line = text.split("\n", 1)[0] ?? "";
	return line.length > maxChars ? `${line.slice(0, maxChars)}…` : line;
}

function readLabel(result: ToolResult): string {
	const file = String(result.args.path ?? result.args.file_path ?? "?");
	const offset = Number(result.args.offset);
	const limit = Number(result.args.limit);
	return Number.isFinite(offset) || Number.isFinite(limit) ? `${file} (offset ${Number.isFinite(offset) ? offset : 1}, limit ${Number.isFinite(limit) ? limit : "-"})` : file;
}

function replacementFor(result: ToolResult, stale: boolean): string {
	if (result.toolName === "read" && stale) return `${PRUNED_MARK} Outdated read of ${readLabel(result)}: a later delegation changed this file. Read the current range again if you need it.`;
	if (result.toolName === "read") return `${PRUNED_MARK} Read of ${readLabel(result)} omitted after its task was accepted; read it again if you need it.`;
	if (result.toolName === "delegate_implementation") {
		const header = result.text.split("\n\n", 1)[0] ?? "";
		const clipped = header.length > 900 ? `${header.slice(0, 900)}…` : header;
		return `${clipped}\n${PRUNED_MARK} Worker report, checks, diff and review omitted after the task was accepted.`;
	}
	if (result.toolName === "complete_task") {
		const last = result.text.trim().split("\n").at(-1) ?? "";
		return `${last}\n${PRUNED_MARK} Review of the whole task omitted after the task was accepted.`;
	}
	// Results that open with their own summary keep it; for the rest (listings, outlines, diffs) the call says more.
	const head = SUMMARY_FIRST_LINE.has(result.toolName) ? `${firstLine(result.text)}\n` : "";
	return `${head}${PRUNED_MARK} ${result.toolName} ${JSON.stringify(result.args).slice(0, 200)} output omitted after the task was accepted; run it again if you need it.`;
}

/**
 * Context edits for the current projection: reads made outdated by a later delegation, and bulky results of
 * accepted tasks (from the prompt that started the task to its acceptance). Nothing when the saving is below
 * minTotalBytes: candidates stay and are reconsidered later, when more has accumulated.
 */
export function planContextEdits(entries: ProjectedEntry[], options: PruneOptions): { edits: ContextEditDraft[]; savedBytes: number } {
	const calls = new Map<string, { name: string; args: Record<string, any> }>();
	const results: ToolResult[] = [];
	const userIndexes: number[] = [];
	entries.forEach((entry, index) => {
		const message = entry.messages.at(-1);
		if (!message || entry.sourceEntry.type !== "message") return;
		if (message.role === "user") userIndexes.push(index);
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const part of message.content) if (part?.type === "toolCall" && typeof part.id === "string") calls.set(part.id, { name: String(part.name), args: part.arguments ?? {} });
		}
		if (message.role !== "toolResult") return;
		const call = calls.get(message.toolCallId);
		results.push({
			index,
			id: entry.sourceEntry.id,
			toolName: String(message.toolName ?? call?.name ?? ""),
			args: call?.args ?? {},
			details: message.details ?? entry.sourceEntry.message?.details,
			text: contentText(message.content),
			bytes: contentBytes(message.content),
		});
	});
	const candidates = new Map<string, { result: ToolResult; stale: boolean }>();
	// Replacements are short; a long result that merely mentions the mark (a read of this file) is not one.
	const isPruned = (result: ToolResult) => result.bytes < 1500 && result.text.includes(PRUNED_MARK);

	// Reads of a file a later delegation changed.
	const delegations = results.filter((result) => result.toolName === "delegate_implementation");
	for (const result of results) {
		if (result.toolName !== "read" || isPruned(result) || result.bytes < 400) continue;
		const file = normalizePath(options.cwd, result.args.path ?? result.args.file_path);
		if (file && delegations.some((delegation) => delegation.index > result.index && changedFiles(delegation, options.cwd).includes(file))) candidates.set(result.id, { result, stale: true });
	}

	// Results of accepted tasks, from the prompt that started the task to its acceptance.
	for (const completion of results) {
		const taskId = completion.details?.taskId;
		if (completion.toolName !== "complete_task" || completion.details?.accepted !== true || !taskId) continue;
		const own = results.filter((result) => (result.toolName === "plan_task" && result.details?.taskId === taskId) || (result.toolName === "delegate_implementation" && result.details?.taskPacketId === taskId));
		if (!own.length) continue;
		const first = Math.min(...own.map((result) => result.index));
		const start = userIndexes.filter((index) => index < first).at(-1) ?? 0;
		for (const result of results) {
			if (result.index < start || result.index > completion.index || result.bytes < options.minResultBytes || isPruned(result) || candidates.has(result.id)) continue;
			candidates.set(result.id, { result, stale: false });
		}
	}

	const edits: ContextEditDraft[] = [];
	let savedBytes = 0;
	for (const { result, stale } of candidates.values()) {
		const text = replacementFor(result, stale);
		const saved = result.bytes - Buffer.byteLength(text, "utf8");
		if (saved < 200) continue;
		edits.push({ type: "context_edit", targetId: result.id, replacement: { content: [{ type: "text", text }] } });
		savedBytes += saved;
	}
	return savedBytes >= options.minTotalBytes ? { edits, savedBytes } : { edits: [], savedBytes: 0 };
}
