/**
 * Learning from use: delegation outcomes calibrate worker effort, and repository lessons recorded by the
 * supervisor are passed to future workers. Pure logic plus small JSON persistence; no Pi imports.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { allowlisted, formatCommand, parseCommand, splitWords } from "./verification.ts";

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

export type VerificationResult = "passed" | "fixed" | "failed" | "unverified" | "unchanged_failures";
export type ReviewVerdict = "pass" | "minor" | "major" | "none";

export interface OutcomeRecord {
	id?: string;
	sequence?: number;
	evidenceVersion?: 2;
	taskKind?: string;
	accepted?: boolean;
	/** provider = credits/outage; budget = stopped by the extension's own turn/time/cost limits; neither measures quality. */
	failureDomain?: "provider" | "quality" | "budget";
	at: number;
	repo: string;
	taskId: string;
	profile: string;
	worker: string;
	model: string;
	effort?: string;
	/** passed = checks green at the first attempt; fixed = green after the correction loop. */
	verification: VerificationResult;
	correctionRounds: number;
	review: ReviewVerdict;
	/** The delegation failed for task reasons (not provider failover). */
	failed: boolean;
	tokens: number;
	costUsd: number;
}

export interface Lesson {
	id: string;
	repo: string;
	text: string;
	createdAt: number;
	uses: number;
	lastUsedAt?: number;
}

export interface EffortAdjustment {
	effort: Effort;
	/** Effort from config.json when the adjustment was made. */
	configured: Effort;
	reason: string;
	since: number;
	cursor?: number;
}

export interface LearningState {
	version: 1;
	sequence?: number;
	outcomes: OutcomeRecord[];
	lessons: Lesson[];
	/** Keyed by `${profile}|${model}`. */
	effortAdjustments: Record<string, EffortAdjustment>;
}

export const MAX_OUTCOMES = 1000;
export const MAX_LESSONS_PER_REPO = 15;
export const MAX_LESSON_CHARS = 300;

export function emptyLearning(): LearningState {
	return { version: 1, outcomes: [], lessons: [], effortAdjustments: {} };
}

export function loadLearning(file: string): LearningState {
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<LearningState>;
		if (parsed.version !== 1) return emptyLearning();
		if (!Array.isArray(parsed.outcomes) || !Array.isArray(parsed.lessons) || !parsed.effortAdjustments || typeof parsed.effortAdjustments !== "object") return emptyLearning();
		const outcomes = parsed.outcomes.filter(item => item && typeof item.repo === "string" && typeof item.model === "string" && Number.isFinite(item.at)).slice(-MAX_OUTCOMES);
		return { version: 1, sequence: Math.max(parsed.sequence ?? 0, ...outcomes.map(item => item.sequence ?? 0)), outcomes, lessons: parsed.lessons.filter(item => item && typeof item.text === "string" && typeof item.repo === "string"), effortAdjustments: parsed.effortAdjustments };
	} catch {
		return emptyLearning();
	}
}

/** Atomic write: a crash mid-write must never leave a truncated learning file. */
export function saveLearning(file: string, state: LearningState): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
	try { fs.writeFileSync(temp, JSON.stringify(state, null, 1)); fs.renameSync(temp, file); }
	finally { fs.rmSync(temp, { force: true }); }
}

/** Serialize read-modify-write across Pi processes. A crashed owner is recoverable; live owners are not stolen. */
export async function updateLearning(file: string, mutate: (state: LearningState) => void): Promise<LearningState> {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const lock = `${file}.lock`;
	let handle: number | undefined;
	for (let attempt = 0; attempt < 100; attempt++) {
		try { handle = fs.openSync(lock, "wx"); fs.writeFileSync(handle, String(process.pid)); break; }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			try {
				const owner = Number(fs.readFileSync(lock, "utf8"));
				if (owner > 0) { try { process.kill(owner, 0); } catch (probe) { if ((probe as NodeJS.ErrnoException).code === "ESRCH") fs.rmSync(lock, { force: true }); } }
			} catch { /* Another writer may have just released the lock. */ }
			await new Promise(resolve => setTimeout(resolve, 25));
		}
	}
	if (handle === undefined) throw new Error("Learning store is busy; update was not written.");
	try { const state = loadLearning(file); mutate(state); saveLearning(file, state); return state; }
	finally { fs.closeSync(handle); fs.rmSync(lock, { force: true }); }
}

/**
 * Quality signal of one delegation, 0..1, or undefined when the outcome carries no evidence
 * (no checks and no review): such outcomes must not move the calibration either way.
 */
export function outcomeQuality(outcome: OutcomeRecord): number | undefined {
	if (outcome.failureDomain === "provider" || outcome.failureDomain === "budget") return undefined;
	if (outcome.failed || outcome.verification === "failed" || outcome.review === "major") return 0;
	if ((outcome.verification === "unverified" || outcome.verification === "unchanged_failures") && outcome.review === "none") return undefined;
	let quality = 1;
	if (outcome.verification === "fixed") quality = Math.min(quality, 0.5);
	if (outcome.review === "minor") quality = Math.min(quality, 0.75);
	return quality;
}

export function recordOutcome(state: LearningState, outcome: OutcomeRecord): void {
	state.sequence = (state.sequence ?? 0) + 1;
	state.outcomes.push({ ...outcome, id: outcome.id ?? randomUUID(), sequence: state.sequence });
	if (state.outcomes.length > MAX_OUTCOMES) state.outcomes.splice(0, state.outcomes.length - MAX_OUTCOMES);
}

export interface TuningRules {
	/** Minimum evidence before raising effort, and the mean quality below which it is raised. */
	raiseMinSamples: number;
	raiseBelowQuality: number;
	/** Lowering needs a long unbroken streak of first-pass, test-verified successes. */
	lowerMinSamples: number;
	/** Profiles where lowering is allowed at all (never large/critical). */
	lowerProfiles: string[];
	window: number;
}

export const DEFAULT_TUNING: TuningRules = { raiseMinSamples: 4, raiseBelowQuality: 0.7, lowerMinSamples: 20, lowerProfiles: ["small", "medium"], window: 12 };

function step(effort: Effort, delta: number): Effort {
	const index = Math.min(EFFORT_LEVELS.length - 1, Math.max(0, EFFORT_LEVELS.indexOf(effort) + delta));
	return EFFORT_LEVELS[index];
}

export interface TuningTarget {
	profile: string;
	model: string;
	configured: Effort;
	repo?: string;
	kind?: string;
}

export function tuningKey(target: { profile: string; model: string; repo?: string; kind?: string }): string {
	return target.repo ? JSON.stringify([target.repo, target.kind ?? "general", target.profile, target.model]) : `${target.profile}|${target.model}`;
}

/** Group outcomes by task, in order of each task's latest delegation: delegations of one task are correlated. */
function byTask(outcomes: OutcomeRecord[]): OutcomeRecord[][] {
	const tasks = new Map<string, OutcomeRecord[]>();
	for (const item of outcomes) {
		const list = tasks.get(item.taskId) ?? [];
		tasks.delete(item.taskId);
		tasks.set(item.taskId, [...list, item]);
	}
	return [...tasks.values()];
}

/**
 * Recompute effort adjustments. Evidence is counted only at the currently effective effort, so every change
 * needs fresh evidence (natural hysteresis). Raising is quick when quality suffers; lowering is slow, one step
 * at most below config.json, and only for low-risk profiles, because quality always wins over tokens.
 * With a repository, one task is one sample and counts with its worst delegation: a failure the supervisor
 * repaired with another delegation is still a failure. Raising looks at every task kind of the repository
 * (a weak model needs help at once); lowering needs evidence for the specific kind.
 */
export function tuneEfforts(state: LearningState, targets: TuningTarget[], rules: TuningRules = DEFAULT_TUNING, now = Date.now()): string[] {
	const changes: string[] = [];
	for (const target of targets) {
		const key = tuningKey(target);
		const existing = state.effortAdjustments[key];
		// A config change resets learning for that key: the user's explicit choice is the new baseline.
		if (existing && existing.configured !== target.configured) {
			state.effortAdjustments[key] = { effort: target.configured, configured: target.configured, reason: "configuration changed; new evidence required", since: now, cursor: state.sequence ?? 0 };
			continue;
		}
		const current = state.effortAdjustments[key]?.effort ?? target.configured;
		const adjustment = state.effortAdjustments[key];
		const evidence = state.outcomes.filter(item => item.profile === target.profile && item.model === target.model && (item.effort ?? target.configured) === current
			&& (!target.repo || (item.repo === target.repo && item.evidenceVersion === 2))
			&& (!adjustment || (item.sequence !== undefined && adjustment.cursor !== undefined ? item.sequence > adjustment.cursor : item.at > adjustment.since))
			&& now - item.at <= 90 * 86400_000);
		// Without a repository (legacy callers) every outcome is its own sample.
		const tasks = target.repo ? byTask(evidence) : evidence.map((item) => [item]);
		const worst = (items: OutcomeRecord[]) => {
			const scores = items.map(outcomeQuality).filter((value): value is number => value !== undefined);
			return scores.length ? Math.min(...scores) : undefined;
		};
		const samples = tasks.map(worst).filter((quality): quality is number => quality !== undefined).slice(-rules.window);
		if (samples.length >= rules.raiseMinSamples) {
			const mean = samples.reduce((sum, quality) => sum + quality, 0) / samples.length;
			if (mean < rules.raiseBelowQuality && current !== "max") {
				const next = step(current, 1);
				state.effortAdjustments[key] = { effort: next, configured: target.configured, reason: `mean quality ${mean.toFixed(2)} over ${samples.length} tasks at ${current}`, since: now, cursor: state.sequence ?? 0 };
				changes.push(`${target.profile}/${target.model}: effort ${current} → ${next} (quality ${mean.toFixed(2)} over ${samples.length})`);
				continue;
			}
		}
		const sameKind = target.repo ? tasks.filter((items) => items.every((item) => (item.taskKind ?? "general") === (target.kind ?? "general"))) : tasks;
		const streak = sameKind.slice(-rules.lowerMinSamples);
		const canLower = rules.lowerProfiles.includes(target.profile) && current !== "low" && EFFORT_LEVELS.indexOf(current) > EFFORT_LEVELS.indexOf(target.configured) - 1;
		if (canLower && streak.length >= rules.lowerMinSamples && streak.every((items) => items.every((item) => item.verification === "passed" && outcomeQuality(item) === 1 && (!target.repo || item.accepted === true)))) {
			const next = step(current, -1);
			state.effortAdjustments[key] = { effort: next, configured: target.configured, reason: `${streak.length} consecutive accepted first-pass successes at ${current}`, since: now, cursor: state.sequence ?? 0 };
			changes.push(`${target.profile}/${target.model}: effort ${current} → ${next} (${streak.length} verified first-pass successes)`);
		}
	}
	return changes;
}

export function effectiveEffort(state: LearningState, profile: string, model: string, configured: Effort | undefined, repo?: string, kind?: string): Effort | undefined {
	if (!configured) return configured;
	const adjustment = state.effortAdjustments[tuningKey({ profile, model, repo, kind })];
	return adjustment && adjustment.configured === configured ? adjustment.effort : configured;
}

export interface ProfileStats {
	profile: string;
	samples: number;
	meanQuality: number;
	firstPassRate: number;
	avgCorrectionRounds: number;
}

/** Per-profile quality in one repository, used to hint the supervisor when a profile is often too weak there. */
export function profileStats(state: LearningState, repo: string | undefined, window = 30): ProfileStats[] {
	const byProfile = new Map<string, OutcomeRecord[]>();
	for (const item of state.outcomes) {
		if (repo && item.repo !== repo) continue;
		byProfile.set(item.profile, [...(byProfile.get(item.profile) ?? []), item]);
	}
	return [...byProfile.entries()].map(([profile, all]) => {
		const items = all.slice(-window);
		const scored = items.map(outcomeQuality).filter((value): value is number => value !== undefined);
		return {
			profile,
			samples: scored.length,
			meanQuality: scored.length ? scored.reduce((sum, value) => sum + value, 0) / scored.length : 1,
			firstPassRate: scored.length ? scored.filter((value) => value === 1).length / scored.length : 1,
			avgCorrectionRounds: items.length ? items.reduce((sum, item) => sum + item.correctionRounds, 0) / items.length : 0,
		};
	});
}

export function profileHint(stats: ProfileStats[], profile: string): string | undefined {
	const current = stats.find((item) => item.profile === profile);
	if (!current || current.samples < 5 || current.meanQuality >= 0.7) return undefined;
	return `In this repository ${profile} delegations reached first-pass quality in only ${Math.round(current.firstPassRate * 100)}% of ${current.samples} recent cases (avg ${current.avgCorrectionRounds.toFixed(1)} correction rounds). If this task is borderline, prefer the next stronger profile and write a more explicit guide.`;
}

function normalizeLesson(text: string): string {
	return text.replace(/\s+/g, " ").trim().slice(0, MAX_LESSON_CHARS);
}

/** Add a repository lesson; near-duplicates reinforce the existing lesson instead of piling up. */
export function addLesson(state: LearningState, repo: string, text: string, now = Date.now()): { lesson: Lesson; duplicate: boolean } {
	const normalized = normalizeLesson(text);
	if (normalized.length < 10) throw new Error("A lesson must be a concrete sentence (at least 10 characters).");
	const key = normalized.toLowerCase();
	const existing = state.lessons.find((item) => item.repo === repo && (item.text.toLowerCase() === key || item.text.toLowerCase().includes(key) || key.includes(item.text.toLowerCase())));
	if (existing) {
		if (normalized.length > existing.text.length) existing.text = normalized;
		existing.uses++;
		existing.lastUsedAt = now;
		return { lesson: existing, duplicate: true };
	}
	const lesson: Lesson = { id: Math.random().toString(36).slice(2, 8), repo, text: normalized, createdAt: now, uses: 0 };
	state.lessons.push(lesson);
	const forRepo = state.lessons.filter((item) => item.repo === repo);
	if (forRepo.length > MAX_LESSONS_PER_REPO) {
		// Evict the least useful: fewest uses, then oldest.
		const evict = [...forRepo].sort((a, b) => a.uses - b.uses || (a.lastUsedAt ?? a.createdAt) - (b.lastUsedAt ?? b.createdAt))[0];
		state.lessons = state.lessons.filter((item) => item !== evict);
	}
	return { lesson, duplicate: false };
}

export function lessonsFor(state: LearningState, repo: string, limit = MAX_LESSONS_PER_REPO): Lesson[] {
	return state.lessons
		.filter((item) => item.repo === repo)
		.sort((a, b) => b.uses - a.uses || b.createdAt - a.createdAt)
		.slice(0, limit);
}

/**
 * The cheapest delegation this repository has recorded: a delegation's floor, measured instead of assumed. The minimum
 * of the recent window, not the mean, because the question it answers is "what does a delegation cost even when the
 * change is trivial"; a mean would be dominated by the large refactors in the same log. Undefined until there is
 * evidence, so the caller states a default instead of an invented number.
 */
export function cheapestDelegationTokens(outcomes: OutcomeRecord[], repo: string, window = 20, now = Date.now()): number | undefined {
	const recent = outcomes
		.filter((item) => item.repo === repo && item.tokens > 0 && now - item.at <= 90 * 86400_000)
		.slice(-window)
		.map((item) => item.tokens);
	return recent.length ? Math.min(...recent) : undefined;
}

export function removeLesson(state: LearningState, id: string): boolean {
	const before = state.lessons.length;
	state.lessons = state.lessons.filter((item) => item.id !== id);
	return state.lessons.length !== before;
}

/**
 * Reviewers end with "VERDICT: PASS|MINOR|MAJOR". The verdict line must be one of the last three non-empty lines
 * (a closing remark after it is tolerated); a verdict buried in the body counts as no usable verdict.
 */
export function parseVerdict(text: string): ReviewVerdict {
	const tail = text.trim().split(/\r?\n/).filter((line) => line.trim()).slice(-3).reverse();
	for (const line of tail) {
		const match = /^\s*\**VERDICT\s*[:=]\s*\**\s*(PASS|MINOR|MAJOR)\b[^\n]*$/i.exec(line);
		if (match) return match[1].toLowerCase() as ReviewVerdict;
	}
	return "none";
}

/**
 * Headers that end the VERIFY section. Only these uppercase guide headers do: labels inside the section
 * ("Commands:", "Run these commands:") are ordinary lines.
 */
const GUIDE_SECTION_HEADER = /^\s*(?:#{1,6}\s*)?\**\s*(?:FILE|FILES|FILE GUIDE|SYMBOL|SYMBOLS|CHANGE|CHANGES|PRESERVE|ACCEPTANCE|ACCEPTANCE CRITERIA|NOTE|NOTES|RISK|RISKS|RESIDUAL RISKS|CONTEXT|CONSTRAINTS|OUT OF SCOPE|NON-GOALS|TASK|OBJECTIVE|PATH ALLOWLIST|ALLOWED PATHS|VERIFY)\s*\**\s*:/;

/**
 * Words that may introduce a bare command ("Run npm test", "Then execute npm test"): dropped from the front when what
 * follows is an allowlisted command. Deliberately no negation or modal ("do", "not", "never", "avoid"), so a line that
 * forbids a command ("Do not run npm test") still matches nothing and no check is derived from it.
 */
const LEAD_WORDS = new Set(["run", "runs", "rerun", "re-run", "running", "execute", "executes", "invoke", "call", "then", "next", "first", "finally", "afterwards", "afterward", "also", "please", "now", "just", "and"]);

/** Words that start prose after a bare command ("npm test should pass"): never passed to the command as arguments. */
const PROSE_WORDS = new Set(["should", "must", "will", "shall", "can", "and", "or", "then", "to", "with", "without", "in", "on", "for", "from", "after", "before", "until", "when", "which", "that", "is", "are", "all", "still", "again", "passes", "pass", "passing", "succeeds", "succeed", "green", "ok", "fails", "fail", "expected", "expect", "e.g.", "i.e."]);

/**
 * Keep a bare command up to the first word of prose. Conservative: running a broader command is harmless, while
 * prose passed as arguments makes the check fail for the wrong reason. Backticked commands are never trimmed.
 * A quoted argument is one word, whatever it contains.
 */
function stripProse(command: string, allowedPrefixes: string[]): string {
	const words = splitWords(command);
	const kept: string[] = [];
	for (const word of words) {
		if (PROSE_WORDS.has(word.toLowerCase()) || /^[(—–]/.test(word)) {
			// "cargo test --features all": an option left without its value would break the command; drop it too,
			// unless it is part of the allowlisted command itself ("node --test").
			const shorter = kept.slice(0, -1).join(" ");
			if (kept.length > 1 && kept[kept.length - 1].startsWith("-") && allowlistedText(shorter, allowedPrefixes)) kept.pop();
			break;
		}
		// "npm test, then lint": a word ending a clause is the command's last word. A full stop ends the sentence, so
		// what follows it is prose ("npm pack --dry-run --json. Also validate the YAML"); it counts only after a word
		// character or a closing quote, so "npx tsc -p ." and "npx eslint src/." keep theirs.
		if (/[,:]$/.test(word) || /(?<=[\w)\]'"])\.$/.test(word)) { kept.push(word.replace(/[,:.]$/, "")); break; }
		kept.push(word);
	}
	return kept.join(" ");
}

/**
 * What parseCommand rejects as line breaks (Unicode separators, vertical tab, form feed included) or control
 * characters. splitWords would turn most of them into plain spaces, so they are caught before it runs.
 */
const HIDDEN_BREAKS = /[\r\n\v\f\x85\p{Zl}\p{Zp}\x00-\x08\x0e-\x1f\x7f]/gu;

/**
 * Commands that change the environment of the ones written after them: splitting a line on its separators would run
 * the rest in another directory or with another environment, so such a line is left whole and rejected as before.
 */
const ENVIRONMENT_COMMANDS = new Set(["cd", "chdir", "pushd", "popd", "export", "set", "unset", "env", "source", "."]);

/**
 * "npm test; npx tsc --noEmit" and "npm test && npx tsc --noEmit" list two commands; they need no shell, because each
 * part becomes its own check, parsed and allowlisted on its own. Only these two separators split a line: a single "&"
 * (background), a pipe, "||" and redirections still reject it, because they change what the command does.
 */
function splitChainedCommands(command: string): string[] {
	const parts = command.split(/;|&&/).map((part) => part.trim()).filter(Boolean);
	if (parts.length < 2) return parts;
	const executable = (part: string) => (splitWords(part)[0] ?? "").replace(/["']/g, "").toLowerCase();
	// One "cd x && npm test" is a single command: running only "npm test" would check the wrong directory.
	return parts.some((part) => ENVIRONMENT_COMMANDS.has(executable(part))) ? [command.trim()] : parts;
}

/**
 * Drop an imperative that introduces a bare command, one word at a time, and stop at the first allowlisted result:
 * "Run npm test after the extraction" is the check "npm test". A command already allowlisted is returned untouched, and
 * a line that never becomes one is returned unchanged, so it is ignored exactly as before.
 */
function dropLeadingImperative(command: string, allowedPrefixes: string[]): string {
	if (allowlistedText(command, allowedPrefixes)) return command;
	const words = splitWords(command);
	for (let start = 1; start < words.length; start++) {
		if (!LEAD_WORDS.has(words[start - 1].replace(/["']/g, "").toLowerCase())) break;
		const candidate = words.slice(start).join(" ");
		if (allowlistedText(candidate, allowedPrefixes)) return candidate;
	}
	return command;
}

function allowlistedText(command: string, allowedPrefixes: string[]): boolean {
	try {
		return allowlisted(parseCommand(command), allowedPrefixes);
	} catch {
		return false;
	}
}

/** A command that does not parse still reads as an allowlisted one when its words begin with a prefix's arguments. */
function looksAllowlisted(command: string, allowedPrefixes: string[]): boolean {
	const words = splitWords(command).map((word) => word.replace(/["']/g, ""));
	return allowedPrefixes.some((prefix) => {
		let tokens: string[];
		try {
			tokens = parseCommand(prefix);
		} catch {
			return false;
		}
		return tokens.length <= words.length && tokens.every((token, index) => words[index].startsWith(token));
	});
}

/**
 * Pull verification commands out of a guide's VERIFY section: backticked commands or bullet lines, parsed and kept
 * only when allowlisted argument by argument. A line listing several commands separated by ";" or "&&" contributes
 * each of them (see splitChainedCommands): they are run one by one, never through a shell.
 * Unknown commands are ignored (the supervisor can still run them);
 * allowlisted-looking ones that are unsafe or malformed are never run, and are listed with the reason in `rejected`.
 * A line with backticks contributes only its backticked commands; a bare command loses any trailing prose, but
 * cleanup never removes shell syntax: a line whose removed part has any is rejected whole.
 * Commands are returned in canonical form (formatCommand).
 */
export function extractVerifyCommands(guide: string, allowedPrefixes: string[], unsafe: RegExp, rejected?: string[]): string[] {
	const lines = guide.split(/\r?\n/);
	const start = lines.findIndex((line) => /^\s*(?:#{1,6}\s*)?\**\s*VERIFY\s*\**\s*:/i.test(line));
	if (start < 0) return [];
	const section = [lines[start].replace(/^[^:]*:/, "")];
	for (const line of lines.slice(start + 1)) {
		if (GUIDE_SECTION_HEADER.test(line)) break;
		section.push(line);
	}
	const candidates: Array<{ command: string; bare: boolean }> = [];
	const add = (command: string, bare: boolean) => {
		for (const part of splitChainedCommands(command)) candidates.push({ command: part, bare });
	};
	for (const line of section) {
		const quoted = [...line.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]);
		if (quoted.length) for (const command of quoted) add(command, false);
		else add(line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, ""), true);
	}
	const result: string[] = [];
	for (const candidate of candidates) {
		if (candidate.command.search(HIDDEN_BREAKS) >= 0) {
			let reason = "line breaks and control characters are not allowed";
			try {
				parseCommand(candidate.command);
			} catch (error) {
				reason = error instanceof Error ? error.message : String(error);
			}
			const shown = candidate.command.trim().replace(HIDDEN_BREAKS, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
			if (looksAllowlisted(candidate.command, allowedPrefixes)) rejected?.push(`${shown} (${reason})`);
			continue;
		}
		// Whitespace collapses between words only: quoted arguments keep theirs.
		const raw = splitWords(candidate.command).join(" ");
		let command = raw;
		// A sentence's full stop or comma ("VERIFY: npm test.") is not part of the command; "npx tsc -p ." and "./..."
		// keep theirs. A semicolon is shell syntax, never punctuation.
		if (candidate.bare) command = command.replace(/(?<=[\w)\]'"])[.,]$/, "");
		// Drop trailing prose after the command ("npm test — all green"); "->" is not prose, ">" redirects.
		// ("--" is kept: npm uses it to forward arguments, e.g. "npm test -- --grep parser").
		const words = splitWords(command);
		const arrow = words.findIndex((word) => /^[—→]/.test(word));
		if (arrow >= 0) command = words.slice(0, arrow).join(" ");
		if (candidate.bare) command = stripProse(dropLeadingImperative(command, allowedPrefixes), allowedPrefixes);
		// Cleanup removes prose only. Shell syntax in the removed part ("npm test should pass; rm x") keeps the whole
		// line, which is then rejected; a remark in parentheses without shell syntax is prose ("node --test (all suites)").
		const removed = raw.startsWith(command) ? raw.slice(command.length) : raw;
		if (unsafe.test(removed.replace(/\([^()]*\)/g, (group) => (unsafe.test(group.slice(1, -1)) ? group : "")))) command = raw;
		if (!command) continue;
		// The unsafe check and the parser see exactly what would run; nothing malformed runs in any other shape.
		let argv: string[];
		try {
			if (unsafe.test(command)) throw new Error("shell operators, redirections and variables are not allowed");
			argv = parseCommand(command);
		} catch (error) {
			if (looksAllowlisted(command, allowedPrefixes)) rejected?.push(`${command} (${error instanceof Error ? error.message : String(error)})`);
			continue;
		}
		// The decision is structural, on the parsed arguments, never on the text.
		if (!allowlisted(argv, allowedPrefixes)) continue;
		command = formatCommand(argv);
		if (!result.includes(command)) result.push(command);
	}
	return result.slice(0, 4);
}

const TEMP_ROOTS = [os.tmpdir(), "/tmp", "/var/tmp"].map((dir) => dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\\|\//g, "[\\\\/]"));
/** An OS temp root and the (usually random) directory under it. */
const TEMP_PATH = new RegExp(`(?:${[...TEMP_ROOTS, "/var/folders/[^/\\s]+/[^/\\s]+/T", "[A-Za-z]:[\\\\/]Users[\\\\/][^\\\\/\\s]+[\\\\/]AppData[\\\\/]Local[\\\\/]Temp"].join("|")})(?:[\\\\/][^\\\\/\\s:'")\\]]+)?`, "gi");

/** Output of a check without volatile parts: colors, clock times, durations, temp directories, addresses, line:column. */
function normalizeCheckOutput(output: string): string[] {
	return output
		.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
		.replace(TEMP_PATH, "<tmp>")
		.replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, "<time>")
		.replace(/\b\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?\b/g, "<time>")
		.replace(/\bduration_ms\b[:\s]*[\d.]+/g, "duration_ms <n>")
		.replace(/\b\d+(?:\.\d+)?\s?(?:ms|µs|us|ns|s|secs?|seconds?|m|mins?|minutes?)\b/g, "<duration>")
		.replace(/\b0x[0-9a-f]+\b/gi, "0x<addr>")
		// TAP numbers shift when a test is added before the failing one ("not ok 3 - name").
		.replace(/^(\s*(?:not )?ok) \d+\b/gm, "$1")
		// Stack frames move when an unrelated line of the file is edited; the failure itself does not.
		.replace(/(\.[A-Za-z]\w{0,5}):\d+(?::\d+)?/g, "$1:<line>")
		.split(/\r?\n/)
		.map((line) => line.replace(/\s+/g, " ").trim())
		.filter(Boolean);
}

/** Lines naming a failing test or error in common runners: TAP, node --test, jest/vitest, pytest, go, cargo, tsc. */
const FAILURE_LINE = /^(?:not ok\b|[✖×✗✘]\s|FAIL(?:ED)?\b|--- FAIL:|●\s|test .* \.\.\. FAILED$)|\berror TS\d+:/;
/**
 * Failure counts of common runners ("# fail 2", "Tests: 1 failed, 3 passed", "Found 2 errors"). Pass and total
 * counts are left out: a worker that adds passing tests must not turn an unchanged failure into a regression.
 */
const FAILURE_COUNT = /(?:#|ℹ)\s*(?:fail|cancelled)\s+\d+|\b\d+\s+(?:failed|failing|failures?|errors?|problems?)\b/gi;

/**
 * Signature of a failed check, to tell whether a check red since the task started still fails the same way.
 * Deliberately conservative: it covers the exit status line, every recognizable failing test/error line and the
 * failure counts, so a new failing test, a different error or a different count all change it. When no failing
 * line is recognizable (an unknown runner), the normalized end of the output stands in for them. Only volatile
 * noise (durations, times, temp paths) and passing tests are ignored; a failure that changed for any other
 * reason is treated as a regression of the task, never silently accepted.
 */
export function failureSignature(output: string): string {
	const lines = normalizeCheckOutput(output);
	const failures = [...new Set(lines.filter((line) => FAILURE_LINE.test(line)))].sort().slice(0, 100);
	const counts = lines.flatMap((line) => line.match(FAILURE_COUNT) ?? []).map((item) => item.toLowerCase().replace(/\s+/g, " ")).slice(-40);
	// The end of a recognized runner's output lists passing tests and totals too: it would change with every test added.
	const tail = failures.length ? [] : lines.slice(-20);
	return createHash("sha256").update(JSON.stringify({ head: lines[0] ?? "", failures, counts, tail })).digest("hex");
}
