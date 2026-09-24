/**
 * Learning from use: delegation outcomes calibrate worker effort, and repository lessons recorded by the
 * supervisor are passed to future workers. Pure logic plus small JSON persistence; no Pi imports.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

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
	failureDomain?: "provider" | "quality";
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
	if (outcome.failureDomain === "provider") return undefined;
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

/**
 * Recompute effort adjustments. Evidence is counted only at the currently effective effort, so every change
 * needs fresh evidence (natural hysteresis). Raising is quick when quality suffers; lowering is slow, one step
 * at most below config.json, and only for low-risk profiles, because quality always wins over tokens.
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
			&& (!target.repo || (item.repo === target.repo && (item.taskKind ?? "general") === (target.kind ?? "general") && item.evidenceVersion === 2))
			&& (!adjustment || (item.sequence !== undefined && adjustment.cursor !== undefined ? item.sequence > adjustment.cursor : item.at > adjustment.since))
			&& now - item.at <= 90 * 86400_000);
		// Multiple delegations of one task are correlated; one task supplies at most one sample.
		const distinct = target.repo ? [...new Map(evidence.map(item => [item.taskId, item])).values()] : evidence;
		const samples = distinct
			.map((item) => ({ item, quality: outcomeQuality(item) }))
			.filter((entry): entry is { item: OutcomeRecord; quality: number } => entry.quality !== undefined)
			.slice(-rules.window);
		if (samples.length >= rules.raiseMinSamples) {
			const mean = samples.reduce((sum, entry) => sum + entry.quality, 0) / samples.length;
			if (mean < rules.raiseBelowQuality && current !== "max") {
				const next = step(current, 1);
				state.effortAdjustments[key] = { effort: next, configured: target.configured, reason: `mean quality ${mean.toFixed(2)} over ${samples.length} tasks at ${current}`, since: now, cursor: state.sequence ?? 0 };
				changes.push(`${target.profile}/${target.model}: effort ${current} → ${next} (quality ${mean.toFixed(2)} over ${samples.length})`);
				continue;
			}
		}
		const streak = distinct.slice(-rules.lowerMinSamples);
		const canLower = rules.lowerProfiles.includes(target.profile) && current !== "low" && EFFORT_LEVELS.indexOf(current) > EFFORT_LEVELS.indexOf(target.configured) - 1;
		if (canLower && streak.length >= rules.lowerMinSamples && streak.every((item) => item.verification === "passed" && outcomeQuality(item) === 1 && (!target.repo || item.accepted === true))) {
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

export function markLessonsUsed(lessons: Lesson[], now = Date.now()): void {
	for (const lesson of lessons) {
		lesson.uses++;
		lesson.lastUsedAt = now;
	}
}

export function removeLesson(state: LearningState, id: string): boolean {
	const before = state.lessons.length;
	state.lessons = state.lessons.filter((item) => item.id !== id);
	return state.lessons.length !== before;
}

/** Reviewers end with "VERDICT: PASS|MINOR|MAJOR"; anything else counts as no usable verdict. */
export function parseVerdict(text: string): ReviewVerdict {
	const match = /^\s*\**VERDICT\s*[:=]\s*\**\s*(PASS|MINOR|MAJOR)\b[^\n]*$/i.exec(text.trim().split(/\r?\n/).at(-1) ?? "");
	return match ? (match[1].toLowerCase() as ReviewVerdict) : "none";
}

/**
 * Pull verification commands out of a guide's VERIFY section: backticked commands or bullet lines that
 * start with an allowlisted prefix. Unknown or unsafe commands are ignored (the supervisor can still run them).
 */
export function extractVerifyCommands(guide: string, allowedPrefixes: string[], unsafe: RegExp): string[] {
	const section = /(^|\n)\s*VERIFY\s*:([\s\S]*?)(?=\n\s*[A-Z][A-Z ]{2,}\s*:|$)/i.exec(guide)?.[2] ?? "";
	const candidates: string[] = [];
	for (const match of section.matchAll(/`([^`\n]+)`/g)) candidates.push(match[1]);
	for (const line of section.split("\n")) candidates.push(line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, ""));
	const result: string[] = [];
	for (const raw of candidates) {
		const command = raw.trim().replace(/\s+/g, " ");
		if (!command || unsafe.test(command)) continue;
		const prefix = allowedPrefixes.find((item) => command === item || command.startsWith(`${item} `));
		if (!prefix) continue;
		// Drop trailing prose after the command ("npm test — all green").
		// ("--" is kept: npm uses it to forward arguments, e.g. "npm test -- --grep parser").
		const clean = command.split(/\s+(?:—|->|→)\s*/)[0].trim();
		if (!result.includes(clean)) result.push(clean);
	}
	return result.slice(0, 4);
}
