/** Deterministic task assessment and conservative, evidence-based model selection. No model calls. */
import { outcomeQuality, type OutcomeRecord } from "./learning.ts";
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
 * No random exploration on user work. Reordering uses only accepted, test-verified tasks from this
 * repository and kind, at the configured effort. Distinct tasks, rather than correction attempts, count.
 * High-risk profiles retain their configured quality order. Cost comparisons need both candidates measured.
 */
export function routeWithEvidence<T extends RoutingCandidate>(candidates: T[], outcomes: OutcomeRecord[], repo: string, profile: Profile, kind: TaskKind, minSamples = 20, now = Date.now()): RoutingDecision<T> {
	const unchanged = { candidates: [...candidates], reason: "configured quality order (insufficient comparable verified evidence)" };
	if (!["small", "medium"].includes(profile) || candidates.length < 2) return unchanged;
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
