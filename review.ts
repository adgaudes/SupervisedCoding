/**
 * Review material and findings. Reviewers get the code around each change and the uses of the declarations it
 * touches, so they need fewer reads; reviews and audits too large for one reviewer are split into shards; findings
 * follow one line format, so shards can be merged, deduplicated and verified. Pure functions: no Git, no models.
 */
import { declarationName, outlineSource, outlineSupported, entryName } from "./outline.ts";

export interface FileDiff {
	file: string;
	text: string;
}

/** A unified diff (git diff, or changesSince) split per file, in order. */
export function splitDiff(diff: string): FileDiff[] {
	return diff.split(/^(?=diff --git )/m).filter((part) => part.startsWith("diff --git ")).map((text) => {
		const target = /^\+\+\+ (?:b\/)?(.+)$/m.exec(text)?.[1]?.trim();
		const header = /^diff --git a\/(.+?) b\/(.+)$/m.exec(text);
		const file = target && target !== "/dev/null" ? target : (header?.[2] ?? header?.[1] ?? "").trim();
		return { file, text };
	});
}

/** New-side line ranges of a file diff's hunks (context lines included). A pure deletion marks where it happened. */
export function hunkRanges(fileDiff: string): Array<[number, number]> {
	const ranges: Array<[number, number]> = [];
	for (const match of fileDiff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
		const start = Math.max(1, Number(match[1]));
		const count = match[2] === undefined ? 1 : Number(match[2]);
		ranges.push([start, start + Math.max(count, 1) - 1]);
	}
	return ranges;
}

/**
 * The declarations around the hunks, where the diff alone does not show them: for each hunk, the largest
 * declaration of at most maxSpan lines that contains it and extends beyond it; inside a longer declaration, `pad`
 * lines around the hunk. Overlapping ranges are merged. Changes outside any declaration (imports, constants) are
 * fully shown by the diff already.
 */
export function enclosingRanges(file: string, source: string, hunks: Array<[number, number]>, maxSpan = 150, pad = 30): Array<[number, number]> {
	if (!outlineSupported(file)) return [];
	const entries = outlineSource(file, source);
	const total = source.split(/\r?\n/).length;
	const ranges: Array<[number, number]> = [];
	for (const [start, end] of hunks) {
		const containing = entries.filter((entry) => entry.line <= start && end <= entry.end);
		const widest = containing.filter((entry) => entry.end - entry.line + 1 <= maxSpan).sort((a, b) => (b.end - b.line) - (a.end - a.line))[0];
		if (widest) {
			if (widest.line < start || widest.end > end) ranges.push([widest.line, widest.end]);
		} else if (containing.length && pad > 0) {
			ranges.push([Math.max(1, start - pad), Math.min(total, end + pad)]);
		}
	}
	ranges.sort((a, b) => a[0] - b[0]);
	const merged: Array<[number, number]> = [];
	for (const range of ranges) {
		const last = merged.at(-1);
		if (last && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1]);
		else merged.push([...range]);
	}
	return merged;
}

/** Numbered source lines of the given ranges, one block per range. */
export function renderRanges(file: string, source: string, ranges: Array<[number, number]>): string {
	const lines = source.split(/\r?\n/);
	const width = String(lines.length).length;
	return ranges.map(([start, end]) => `${file}:${start}-${end}\n${lines.slice(start - 1, end).map((text, index) => `${String(start + index).padStart(width)}| ${text}`).join("\n")}`).join("\n\n");
}

/**
 * Declarations a file diff touches, as names to look up: first those whose declaration line was changed or removed
 * (a signature change can break callers), then the declarations whose body changed (a behavior change can).
 */
export function touchedDeclarations(fileDiff: FileDiff, source: string | undefined): { signatures: string[]; bodies: string[] } {
	const valid = (name: string | undefined): name is string => Boolean(name && /^[\w$]{3,}$/.test(name));
	const signatures = new Set<string>();
	for (const line of fileDiff.text.split("\n")) {
		if (!line.startsWith("-") || line.startsWith("---")) continue;
		const name = declarationName(fileDiff.file, line.slice(1));
		if (valid(name)) signatures.add(name);
	}
	const bodies = new Set<string>();
	if (source !== undefined && outlineSupported(fileDiff.file)) {
		const entries = outlineSource(fileDiff.file, source);
		for (const [start, end] of hunkRanges(fileDiff.text)) {
			const innermost = entries.filter((entry) => entry.line <= start && end <= entry.end).at(-1);
			const name = innermost ? entryName(innermost.text) : undefined;
			if (valid(name) && !signatures.has(name)) bodies.add(name);
		}
	}
	return { signatures: [...signatures], bodies: [...bodies] };
}

// ── Findings ───────────────────────────────────────────────────────────────────────────────────────

export type Severity = "MAJOR" | "MINOR";

export interface Finding {
	severity: Severity;
	/** Repository-relative path, or "" when the finding names none. */
	file: string;
	line?: number;
	text: string;
	/** Who reported it (reviewer label, shard). */
	source?: string;
	/** Set by a verification pass. */
	status?: "confirmed" | "downgraded" | "unverified";
}

/** Output format asked of reviewers and auditors: one line per finding, so results can be merged and verified. */
export const FINDINGS_FORMAT = [
	"Report findings one per line, most severe first, exactly in this form:",
	"- [MAJOR] path/to/file.ext:LINE — the defect and its evidence — the fix",
	"- [MINOR] path/to/file.ext:LINE — the defect and its evidence — the fix",
	"MAJOR = defects that give wrong results, crash, lose data or open a security hole in realistic use (including callers the change breaks), missed requirements and regressions; MINOR = anything else worth fixing, including hardening against inputs the code's callers do not produce. List every MAJOR finding and at most 10 MINOR ones (the most important). If there is none, write `No findings.` No preamble and no summary of the code. Then at most 3 lines starting with `Risk:` for residual risks or what you could not check.",
].join("\n");

const FINDING_LINE = /^\s*(?:[-*•]\s*|\d+[.)]\s*)?\**\[(MAJOR|MINOR)\]\**\s*(.+)$/i;
const LOCATION = /^`?([^\s`]+?)(?::(\d+)(?:\s*[-–]\s*\d+)?)?`?\s*(?:—|–|--?|:)\s*(.+)$/;

export interface ParsedReview {
	findings: Finding[];
	risks: string[];
	/** Lines that are neither findings, risks nor the verdict. */
	other: string[];
}

export function parseFindings(text: string, source?: string): ParsedReview {
	const result: ParsedReview = { findings: [], risks: [], other: [] };
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line) continue;
		const finding = FINDING_LINE.exec(line);
		if (finding) {
			const rest = finding[2].trim();
			const location = LOCATION.exec(rest);
			const looksLikePath = Boolean(location && /[./\\]/.test(location[1]) && !/\s/.test(location[1]));
			result.findings.push({
				severity: finding[1].toUpperCase() as Severity,
				file: looksLikePath ? location![1].replace(/\\/g, "/").replace(/^\.\//, "") : "",
				line: looksLikePath && location![2] ? Number(location![2]) : undefined,
				text: looksLikePath ? location![3].trim() : rest,
				source,
			});
		} else if (/^\**risk\**\s*:/i.test(line)) {
			result.risks.push(line.replace(/^\**risk\**\s*:\s*/i, ""));
		} else if (!/^\**VERDICT\s*[:=]/i.test(line) && !/^no findings\.?$/i.test(line)) {
			result.other.push(line);
		}
	}
	return result;
}

/** Findings of several reviewers, deduplicated by severity and location, MAJOR first. */
export function mergeFindings(lists: Finding[][]): Finding[] {
	const seen = new Set<string>();
	const merged: Finding[] = [];
	for (const finding of lists.flat()) {
		const key = finding.file ? `${finding.severity}|${finding.file}|${finding.line ?? ""}` : `${finding.severity}|${finding.text.toLowerCase().slice(0, 80)}`;
		if (seen.has(key)) continue;
		seen.add(key);
		merged.push(finding);
	}
	return merged.sort((a, b) => Number(a.severity === "MINOR") - Number(b.severity === "MINOR"));
}

export function formatFinding(finding: Finding, index?: number): string {
	const location = finding.file ? `${finding.file}${finding.line ? `:${finding.line}` : ""} — ` : "";
	const status = finding.status ? ` (${finding.status})` : "";
	return `- ${index !== undefined ? `#${index} ` : ""}[${finding.severity}]${status} ${location}${finding.text}`;
}

export type VerificationStatus = "confirmed" | "minor" | "rejected" | "unsure";

/** `#n CONFIRMED|MINOR|REJECTED|UNSURE — reason` lines of a verification answer. */
export function parseVerification(text: string): Map<number, { status: VerificationStatus; reason: string }> {
	const result = new Map<number, { status: VerificationStatus; reason: string }>();
	for (const raw of text.split(/\r?\n/)) {
		const match = /^\s*(?:[-*]\s*)?#?(\d+)\s*[:.)\-—]?\s*\**\s*(CONFIRMED|MINOR|REJECTED|UNSURE)\b\**\s*(?:—|–|--?|:)?\s*(.*)$/i.exec(raw);
		if (match) result.set(Number(match[1]), { status: match[2].toLowerCase() as VerificationStatus, reason: match[3].trim() });
	}
	return result;
}

// ── Shards ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * Consecutive items grouped into at most maxShards groups of about maxBytes each (the budget grows when needed):
 * order is kept, so files of one directory stay together.
 */
export function packShards<T extends { bytes: number }>(items: T[], maxBytes: number, maxShards: number): T[][] {
	let budget = Math.max(1, maxBytes);
	for (;;) {
		const shards: T[][] = [];
		let current: T[] = [];
		let size = 0;
		for (const item of items) {
			if (current.length && size + item.bytes > budget) {
				shards.push(current);
				current = [];
				size = 0;
			}
			current.push(item);
			size += item.bytes;
		}
		if (current.length) shards.push(current);
		if (shards.length <= Math.max(1, maxShards)) return shards;
		budget = Math.ceil(budget * 1.25);
	}
}

/** The selected files, with every directory whose inventoried files are all selected written as the directory. */
export function compressPaths(selected: string[], inventory: string[]): string[] {
	const chosen = new Set(selected);
	const dirs = new Set<string>();
	for (const file of selected) {
		const parts = file.split("/");
		for (let depth = 1; depth < parts.length; depth++) dirs.add(parts.slice(0, depth).join("/"));
	}
	const covered: string[] = [];
	const isCovered = (item: string) => covered.some((dir) => item.startsWith(`${dir}/`));
	for (const dir of [...dirs].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))) {
		if (isCovered(dir)) continue;
		const under = inventory.filter((file) => file.startsWith(`${dir}/`));
		if (under.length && under.every((file) => chosen.has(file))) covered.push(dir);
	}
	return [...covered, ...selected.filter((file) => !isCovered(file))];
}

/** Runs fn over items with at most `limit` running at once; results keep the items' order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await fn(items[index], index);
		}
	};
	await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
	return results;
}
