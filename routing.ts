/** Deterministic task assessment and conservative, evidence-based model selection. No model calls. */
import { DEFAULT_TUNING, outcomeQuality, type OutcomeRecord } from "./learning.ts";
import type { Effort } from "./learning.ts";

export const TASK_KINDS = ["general", "mechanical", "docs", "tests", "feature", "bugfix", "refactor", "architecture", "security", "concurrency", "migration"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];
export type Profile = "small" | "medium" | "large" | "critical";
export interface TaskAssessment {
	kind: TaskKind;
	risk: "low" | "medium" | "high";
	uncertainty: "low" | "medium" | "high";
	scope: "local" | "multi-file" | "cross-system";
}
export const DEFAULT_ASSESSMENT: TaskAssessment = { kind: "general", risk: "medium", uncertainty: "medium", scope: "local" };
const PROFILES: Profile[] = ["small", "medium", "large", "critical"];

/** Explicit risk floors may raise, never silently lower, the supervisor's requested profile. */
export function assessTask(requested: Profile, input?: Partial<TaskAssessment>): { profile: Profile; assessment: TaskAssessment; reasons: string[] } {
	const assessment = { ...DEFAULT_ASSESSMENT, ...input };
	let floor: Profile = "small";
	const reasons: string[] = [];
	const raise = (level: Profile, reason: string) => { if (PROFILES.indexOf(level) > PROFILES.indexOf(floor)) floor = level; reasons.push(reason); };
	if (["security", "concurrency", "migration"].includes(assessment.kind) || assessment.risk === "high") raise("critical", "high-consequence work");
	if (assessment.kind === "architecture" || assessment.scope === "cross-system" || assessment.uncertainty === "high") raise("large", "architecture, cross-system scope or high uncertainty");
	if (assessment.scope === "multi-file") raise("medium", "multi-file scope");
	const profile = PROFILES[Math.max(PROFILES.indexOf(requested), PROFILES.indexOf(floor))];
	return { profile, assessment, reasons: profile !== requested ? reasons : [] };
}

/** The only cold-start reduction is explicit, local, low-risk mechanical/docs work. */
export function taskEffort(profile: Profile, assessment: TaskAssessment | undefined, configured: Effort | undefined): Effort | undefined {
	if (configured && profile === "small" && assessment?.risk === "low" && assessment.uncertainty === "low" && assessment.scope === "local" && ["mechanical", "docs"].includes(assessment.kind)) return "low";
	return configured;
}

export interface RoutingCandidate { worker: string; model: string; effort?: string; provider?: string }
export interface RoutingDecision<T> { candidates: T[]; reason: string }

/**
 * No random exploration on user work. The configured order is the starting quality judgement; evidence from this
 * repository and task kind changes it in two ways only. Escalation (any profile): a first candidate with poor
 * quality at its highest effort yields to the next one that is not struggling. Savings (small/medium only):
 * a candidate at least 20% cheaper moves ahead after enough accepted, test-verified, first-pass tasks, measured
 * for both. Distinct tasks, rather than correction attempts, count.
 */
export function routeWithEvidence<T extends RoutingCandidate>(candidates: T[], outcomes: OutcomeRecord[], repo: string, profile: Profile, kind: TaskKind, minSamples = 20, now = Date.now()): RoutingDecision<T> {
	const unchanged = { candidates: [...candidates], reason: "configured quality order (insufficient comparable verified evidence)" };
	if (candidates.length < 2) return unchanged;
	// Escalation (every profile, because it protects quality): learning first raises a model's effort; a model that
	// still performs poorly at its highest effort, or that has no effort to raise, yields to the next candidate.
	const struggling = (candidate: T) => {
		const tasks = new Map<string, OutcomeRecord[]>();
		for (const item of outcomes) {
			if (item.evidenceVersion !== 2 || item.repo !== repo || item.profile !== profile || (item.taskKind ?? "general") !== kind || item.worker !== candidate.worker || item.model !== candidate.model || now - item.at > 90 * 86400_000) continue;
			if (candidate.effort && item.effort !== "max") continue;
			const list = tasks.get(item.taskId) ?? [];
			tasks.delete(item.taskId);
			tasks.set(item.taskId, [...list, item]);
		}
		const scores = [...tasks.values()]
			.map((items) => items.map(outcomeQuality).filter((value): value is number => value !== undefined))
			.filter((values) => values.length)
			.map((values) => Math.min(...values))
			.slice(-DEFAULT_TUNING.window);
		if (scores.length < DEFAULT_TUNING.raiseMinSamples) return undefined;
		const mean = scores.reduce((sum, value) => sum + value, 0) / scores.length;
		return mean < DEFAULT_TUNING.raiseBelowQuality ? { mean, n: scores.length } : undefined;
	};
	const poor = struggling(candidates[0]);
	if (poor) {
		const next = candidates.findIndex((candidate, index) => index > 0 && !struggling(candidate));
		if (next > 0) {
			return {
				candidates: [candidates[next], ...candidates.filter((_, index) => index !== next)],
				reason: `${candidates[0].model} reached quality ${poor.mean.toFixed(2)} over ${poor.n} tasks of this kind at its highest effort; escalated to ${candidates[next].model}`,
			};
		}
	}
	if (!["small", "medium"].includes(profile)) return unchanged;
	const stats = (candidate: T) => {
		const tasks = new Map<string, OutcomeRecord[]>();
		for (const item of outcomes) {
			if (item.evidenceVersion !== 2 || !item.accepted || item.failureDomain === "provider" || item.repo !== repo || item.profile !== profile || (item.taskKind ?? "general") !== kind || item.worker !== candidate.worker || item.model !== candidate.model || item.effort !== candidate.effort || now - item.at > 90 * 86400_000) continue;
			const list = tasks.get(item.taskId) ?? []; list.push(item); tasks.set(item.taskId, list);
		}
		const recent = [...tasks.values()].slice(-Math.max(minSamples, 30));
		if (recent.length < minSamples || recent.some(items => items.some(item => item.verification !== "passed" || outcomeQuality(item) !== 1 || !(item.costUsd > 0)))) return undefined;
		return { cost: recent.reduce((sum, items) => sum + items.reduce((n, item) => n + item.costUsd, 0), 0) / recent.length, n: recent.length };
	};
	const baseline = stats(candidates[0]);
	if (!baseline) return unchanged;
	const measured = candidates.map((candidate, index) => ({ candidate, index, evidence: stats(candidate) }));
	const eligible = measured.filter(item => item.evidence && item.evidence.cost < baseline.cost * 0.8).sort((a, b) => a.evidence!.cost - b.evidence!.cost);
	const best = eligible[0];
	if (!best) return unchanged;
	return { candidates: [best.candidate, ...candidates.filter((_, index) => index !== best.index)], reason: `${best.candidate.model}: ${best.evidence!.n} accepted first-pass tasks of this kind; measured mean cost at least 20% below the configured first candidate` };
}
