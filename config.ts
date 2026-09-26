import * as fs from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { claudeFamily } from "./lib.ts";
import { parseAllowlist } from "./verification.ts";

export const PROFILE_NAMES = ["small", "medium", "large", "critical"] as const;
export const WORKER_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export type WorkerEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ExecutionProfileName = (typeof PROFILE_NAMES)[number];
/**
 * claude = Claude Code CLI; pi = any model configured in Pi (e.g. GPT through an OpenAI Codex subscription), run
 * through Pi's own CLI; api = a read-only reviewer called directly through a Pi provider (no CLI prompt overhead).
 * Every model can implement or review: roles follow the task, never the model family.
 */
export type WorkerKind = "claude" | "pi" | "api";

export interface WorkerCandidate {
	worker: WorkerKind;
	/** Model id (Claude Code model, or the model of the Pi provider). */
	model: string;
	effort?: WorkerEffort;
	/** Pi provider, for "pi" workers and "api" reviewers. */
	provider?: string;
	maxTurns?: number;
	maxBudgetUsd?: number;
}

export interface SupervisorCandidate {
	provider: string;
	model: string;
}

export interface Config {
	workerCommand: string;
	/** Extra leading arguments for workerCommand (e.g. a script path when workerCommand is node). */
	workerCommandArgs: string[];
	/** Pi's CLI for "pi" workers ("pi" = the Pi installation running this extension). */
	piCommand: string;
	piCommandArgs: string[];
	/** Tools of a "pi" implementer and of a "pi" read-only reviewer (Pi has no per-command shell allowlist). */
	piWorkerTools: string[];
	piReadOnlyTools: string[];
	/** Read-only reviews through a Pi provider API, used only with complete review material. null disables it. */
	reviewApi: { provider: string; model: string; reasoning: ThinkingLevel } | null;
	/** Run the guide's VERIFY commands before and after each delegation and let the worker fix regressions. */
	autoVerify: boolean;
	/**
	 * Reuse a check's result, within one user prompt, when it already ran on exactly the same repository state
	 * (HEAD, index and every changed or untracked file). Off when the supervisor has a shell.
	 */
	reuseChecks: boolean;
	maxCorrectionRounds: number;
	/** Repository instruction files given to every worker (they run in --safe-mode and would not load them). */
	repoRulesFiles: string[];
	maxDiffBytes: number;
	learning: { enabled: boolean; autoTuneEffort: boolean; autoRouteModels: boolean; minModelSamples: number };
	supervisorProfiles: Partial<Record<ExecutionProfileName, SupervisorCandidate[]>>;
	probeTtlMinutes: number;
	probeMaxTokens: number;
	reviewMaxTokens: number;
	workerMaxTurns: Record<ExecutionProfileName, number>;
	delegationTimeoutMinutes: number;
	delegationBudgetUsd: number;
	maxProcessOutputBytes: number;
	workerPermissionMode: "acceptEdits" | "auto" | "bypassPermissions" | "manual" | "dontAsk" | "plan";
	workerTools: string[];
	workerAllowedTools: string[];
	workerDisallowedTools: string[];
	claudeReadOnlyTools: string[];
	claudeReadOnlyAllowedTools: string[];
	claudeReadOnlyDisallowedTools: string[];
	/** Ordered by preference (best first) for each complexity profile. */
	workerChains: Record<ExecutionProfileName, WorkerCandidate[]>;
	defaultExecutionProfile: ExecutionProfileName;
	independentReviewProfiles: ExecutionProfileName[];
	/** Ordered by preference (best first); only candidates with configured Pi auth are considered. */
	supervisorChain: SupervisorCandidate[];
	/** Top-tier models used only for critical tasks and only after the user answers Yes. */
	flagshipModels: string[];
	/** Supervisor reasoning effort per task profile ("default" = no open task). */
	supervisorEffort: Record<ExecutionProfileName | "default", ThinkingLevel>;
	/** Command prefixes the supervisor may run through run_verification. */
	verificationCommands: string[];
	verificationTimeoutMinutes: number;
	supervisorAutoSelect: boolean;
	supervisorFailover: boolean;
	probeOnActivate: boolean;
	claudeProbeModel: string;
	/** Utilization (0..1) above which a provider is used only after healthier candidates. */
	creditHeadroom: number;
	exhaustedCooldownMinutes: number;
	unavailableCooldownMinutes: number;
	transientRetryAttempts: number;
	transientRetryDelayMs: number;
	workerTimeoutMinutes: number;
	consultTimeoutMinutes: number;
	automaticSupervisorRecovery: boolean;
	recoveryMaxAgeMinutes: number;
	contextWarningPercent: number;
	allowedSupervisorProviders: string[];
	supervisorTools: string[];
	maxOutputBytes: number;
	/** Per-tool caps below maxOutputBytes: every byte returned to the supervisor is resent on each later turn. */
	outputLimits: OutputLimits;
	minImplementationGuideChars: Record<ExecutionProfileName, number>;
	/**
	 * Supervisor context pruning at the end of each run: reads made outdated by a later delegation and bulky results
	 * of accepted tasks become one-line notes, when that saves at least minTotalBytes (each batch costs one prompt
	 * cache miss).
	 */
	contextPruning: { enabled: boolean; minResultBytes: number; minTotalBytes: number };
	/** Reviewers of one review_changes or audit working at the same time. */
	reviewConcurrency: number;
	/** review_changes splits a diff larger than maxDiffBytes into at most this many shards. */
	reviewMaxShards: number;
	/** An audit of more source than this is split among several consultants, at most auditMaxShards. */
	auditShardBytes: number;
	auditMaxShards: number;
	/**
	 * The API reviewer gets whole changed files up to this size; above it, and up to 250 KB, it gets the code around
	 * each change, outlines of large files and the uses of changed declarations instead.
	 */
	reviewWholeFilesBytes: number;
	/** Code around the changes and uses of changed declarations given to every reviewer. */
	reviewContextBytes: number;
	/** Outline and uses of the guide's symbols given to fresh workers for large files (0 disables it). */
	workerCodeMapBytes: number;
	/** A delegation whose only target is smaller than this, for a mechanical change, is questioned once. 0 disables the check. */
	tinyDelegationBytes: number;
	/** Path segments and extensions that mark consequential work, per task kind. Empty disables the corroboration. */
	sensitivePaths: Record<string, { segments: string[]; extensions: string[] }>;
}

export interface OutputLimits {
	/** End of a passing run_verification command: the verdict and summary are all the supervisor needs. */
	verificationPassBytes: number;
	/** End of a failing run_verification command, where test runners print failures and summaries. */
	verificationFailBytes: number;
	/** consult_readonly answers and reviews (start and end kept: the verdict comes last). */
	consultBytes: number;
	/** The worker's own report inside a delegation result, so the review and the diff are never cut. */
	workerReportBytes: number;
	/** code_outline output. */
	outlineBytes: number;
}

export const OUTPUT_LIMIT_DEFAULTS: OutputLimits = { verificationPassBytes: 2000, verificationFailBytes: 12_000, consultBytes: 24_000, workerReportBytes: 8000, outlineBytes: 24_000 };

/**
 * Starting quality order per profile (config.json normally overrides it). Claude Code leads where its harness
 * matters (per-command shell permissions, so the worker can run the tests itself); GPT through Pi alternates with
 * it on a different subscription, so one provider's limit never stops the work. Learning escalates or reorders
 * with evidence.
 */
export const DEFAULT_WORKER_CHAINS: Record<ExecutionProfileName, WorkerCandidate[]> = {
	small: [
		{ worker: "claude", model: "claude-sonnet-5", effort: "medium" },
		{ worker: "pi", provider: "openai-codex", model: "gpt-6-sol", effort: "medium" },
		{ worker: "claude", model: "claude-opus-5-5", effort: "low" },
	],
	medium: [
		{ worker: "claude", model: "claude-sonnet-5", effort: "high" },
		{ worker: "pi", provider: "openai-codex", model: "gpt-5.5", effort: "high" },
		{ worker: "claude", model: "claude-opus-5-5", effort: "medium" },
		{ worker: "pi", provider: "openai-codex", model: "gpt-6-sol", effort: "high" },
	],
	large: [
		{ worker: "claude", model: "claude-opus-5-5", effort: "high" },
		{ worker: "pi", provider: "openai-codex", model: "gpt-5.5", effort: "xhigh" },
		{ worker: "claude", model: "claude-sonnet-5", effort: "xhigh" },
	],
	critical: [
		{ worker: "claude", model: "claude-fable-5-1", effort: "xhigh" },
		{ worker: "pi", provider: "openai-codex", model: "gpt-6-astra", effort: "xhigh" },
		{ worker: "claude", model: "claude-opus-5-5", effort: "xhigh" },
		{ worker: "pi", provider: "openai-codex", model: "gpt-5.5", effort: "xhigh" },
		{ worker: "claude", model: "claude-sonnet-5", effort: "max" },
	],
};

export type RawConfig = Partial<Config>;

/** Plain objects are merged one level deep (e.g. one profile of workerChains); arrays and scalars are replaced. */
export function mergeConfig(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
	const merged: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(override)) {
		const current = merged[key];
		const plain = (item: unknown) => Boolean(item) && typeof item === "object" && !Array.isArray(item);
		merged[key] = plain(current) && plain(value) ? { ...(current as object), ...(value as object) } : value;
	}
	return merged;
}

/**
 * Profile names from the configuration, checked like the commands they gate. A misspelt entry ("larg") would silently
 * switch off the review it was meant to require, so the configuration is refused instead, naming the entry.
 */
function validProfiles(value: unknown, key: string, source: string): ExecutionProfileName[] {
	if (!Array.isArray(value)) throw new Error(`${key} must be an array of profile names (${source}).`);
	const unknown = value.filter((item) => !PROFILE_NAMES.includes(item as ExecutionProfileName));
	if (unknown.length) throw new Error(`Invalid ${key} entry ${JSON.stringify(unknown[0])}: expected one of ${PROFILE_NAMES.join(", ")} (${source}).`);
	return value as ExecutionProfileName[];
}

export function loadConfig(configPath: string, userConfigPath: string | undefined, customTools: Iterable<string>): Config {
	const defaults = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
	// Personal settings live outside the package, so updates never overwrite them.
	const personal = userConfigPath && fs.existsSync(userConfigPath) ? JSON.parse(fs.readFileSync(userConfigPath, "utf8")) as Record<string, unknown> : {};
	const raw = mergeConfig(defaults, personal) as RawConfig;
	const chainsSource = raw.workerChains ?? DEFAULT_WORKER_CHAINS;
	const workerChains = Object.fromEntries(PROFILE_NAMES.map((name) => [name, chainsSource[name]?.length ? chainsSource[name] : DEFAULT_WORKER_CHAINS[name]])) as Record<ExecutionProfileName, WorkerCandidate[]>;
	for (const [name, chain] of Object.entries(workerChains)) {
		for (const candidate of chain) {
			if (candidate.worker !== "claude" && candidate.worker !== "pi") throw new Error(`Invalid worker '${String(candidate.worker)}' in workerChains.${name} (${configPath}).`);
			if (candidate.worker === "claude" && !candidate.model) throw new Error(`Claude candidates need a model in workerChains.${name} (${configPath}).`);
			if (candidate.worker === "pi" && (!candidate.provider || !candidate.model)) throw new Error(`Pi candidates need a provider and a model in workerChains.${name} (${configPath}).`);
		}
	}
	const requestedDefault = raw.defaultExecutionProfile;
	const rawMinGuide = (raw as { minImplementationGuideChars?: number | Partial<Record<ExecutionProfileName, number>> }).minImplementationGuideChars;
	const guideDefaults: Record<ExecutionProfileName, number> = { small: 150, medium: 400, large: 400, critical: 400 };
	const minImplementationGuideChars = Object.fromEntries(PROFILE_NAMES.map((name) => [name, typeof rawMinGuide === "number" ? rawMinGuide : rawMinGuide?.[name] ?? guideDefaults[name]])) as Record<ExecutionProfileName, number>;
	if (Object.values(minImplementationGuideChars).some((value) => !(value >= 1))) throw new Error(`Invalid implementation guide minimum in ${configPath}.`);
	const flagshipModels = raw.flagshipModels ?? ["claude-fable-5-1", "claude-fable-5", "gpt-6-astra"];
	for (const field of ["transientRetryAttempts", "maxCorrectionRounds", "workerTimeoutMinutes", "consultTimeoutMinutes", "verificationTimeoutMinutes", "delegationTimeoutMinutes", "delegationBudgetUsd", "probeTtlMinutes", "exhaustedCooldownMinutes", "unavailableCooldownMinutes", "transientRetryDelayMs", "recoveryMaxAgeMinutes"] as const) {
		const value = raw[field];
		if (value !== undefined && (!Number.isFinite(value) || value < 0)) throw new Error(`${field} must be a finite non-negative number.`);
	}
	for (const field of ["maxDiffBytes", "maxOutputBytes", "maxProcessOutputBytes", "probeMaxTokens", "reviewMaxTokens", "auditShardBytes", "reviewWholeFilesBytes", "reviewContextBytes"] as const) {
		const value = raw[field];
		if (value !== undefined && (!Number.isInteger(value) || value < 128)) throw new Error(`${field} must be an integer >= 128.`);
	}
	for (const field of ["reviewConcurrency", "reviewMaxShards", "auditMaxShards"] as const) {
		const value = raw[field];
		if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > 20)) throw new Error(`${field} must be an integer between 1 and 20.`);
	}
	if (raw.workerCodeMapBytes !== undefined && (!Number.isInteger(raw.workerCodeMapBytes) || raw.workerCodeMapBytes < 0)) throw new Error("workerCodeMapBytes must be a non-negative integer (0 disables the code map).");
	const contextPruning = { enabled: true, minResultBytes: 1500, minTotalBytes: 20_000, ...raw.contextPruning };
	if (!Number.isInteger(contextPruning.minResultBytes) || contextPruning.minResultBytes < 256 || !Number.isInteger(contextPruning.minTotalBytes) || contextPruning.minTotalBytes < 0) throw new Error("contextPruning.minResultBytes must be an integer >= 256 and contextPruning.minTotalBytes a non-negative integer.");
	const outputLimits: OutputLimits = { ...OUTPUT_LIMIT_DEFAULTS, ...raw.outputLimits };
	for (const [field, value] of Object.entries(outputLimits)) {
		if (!Number.isInteger(value) || value < 128) throw new Error(`outputLimits.${field} must be an integer >= 128.`);
	}
	if ((raw.transientRetryAttempts ?? 4) > 10 || !Number.isInteger(raw.transientRetryAttempts ?? 4) || (raw.maxCorrectionRounds ?? 2) > 10 || !Number.isInteger(raw.maxCorrectionRounds ?? 2)) throw new Error("Retry/correction counts must be integers between 0 and 10.");
	for (const candidate of Object.values(workerChains).flat()) if (candidate.effort && !WORKER_EFFORTS.includes(candidate.effort)) throw new Error(`Invalid effort for ${candidate.model}.`);
	if (raw.reviewApi && flagshipModels.includes(raw.reviewApi.model)) throw new Error("Flagship models cannot be used for API reviews.");
	if (flagshipModels.includes(raw.claudeProbeModel ?? "claude-haiku-4-5")) throw new Error("Flagship models cannot be used for probes.");
	const workerMaxTurns = { small: 40, medium: 80, large: 120, critical: 160, ...raw.workerMaxTurns };
	if (Object.values(workerMaxTurns).some(n => !Number.isInteger(n) || n < 1 || n > 1000)) throw new Error("workerMaxTurns must contain integers between 1 and 1000.");
	if (!Number.isInteger(raw.learning?.minModelSamples ?? 20) || (raw.learning?.minModelSamples ?? 20) < 20) throw new Error("learning.minModelSamples must be an integer >= 20.");
	const flagshipOutsideCritical = PROFILE_NAMES.filter((name) => name !== "critical" && workerChains[name].some((item) => flagshipModels.includes(item.model)));
	if (flagshipOutsideCritical.length) throw new Error(`Flagship models are reserved for the critical profile; remove them from workerChains.${flagshipOutsideCritical.join(", ")} (${configPath}).`);
	const headroom = raw.creditHeadroom ?? 0.97;
	if (!(headroom > 0 && headroom <= 1)) throw new Error(`creditHeadroom must be in (0, 1] in ${configPath}.`);
	const verificationCommands = raw.verificationCommands ?? [
		"npm test", "npm run test", "npm run lint", "npm run typecheck", "npm run check", "npm run build",
		"npx tsc", "npx vitest run", "npx eslint", "npx jest",
		"pnpm test", "pnpm run test", "pnpm run lint", "pnpm run typecheck", "yarn test",
		"node --test", "pytest", "python -m pytest", "py -m pytest", "ruff check", "mypy",
		"cargo test", "cargo check", "cargo clippy", "go test", "go vet", "dotnet test", "dotnet build",
	];
	// Checked like the commands they allow: a prefix that cannot be parsed would silently match nothing.
	if (!Array.isArray(verificationCommands)) throw new Error(`verificationCommands must be an array of commands (${configPath}).`);
	try {
		parseAllowlist(verificationCommands);
	} catch (error) {
		throw new Error(`${error instanceof Error ? error.message : String(error)} (${configPath}).`);
	}
	const configuredAllowed = raw.workerAllowedTools ?? [
		"Read", "Edit", "Write", "Glob", "Grep",
		"Bash(git status *)", "Bash(git diff *)", "Bash(git log *)",
	];
	// Workers may always run the checks the extension itself runs, so they can iterate on failures before reporting.
	const verificationPatterns = verificationCommands.flatMap((command) => [`Bash(${command})`, `Bash(${command} *)`]);
	const workerAllowedTools = [...configuredAllowed, ...verificationPatterns.filter((item) => !configuredAllowed.includes(item))];
	return {
		workerCommand: raw.workerCommand ?? "claude",
		workerCommandArgs: raw.workerCommandArgs ?? [],
		piCommand: raw.piCommand ?? "pi",
		piCommandArgs: raw.piCommandArgs ?? [],
		// No shell by default: Pi cannot restrict it to the verification commands, and the extension runs VERIFY itself.
		piWorkerTools: raw.piWorkerTools ?? ["read", "edit", "write", "grep", "find", "ls"],
		piReadOnlyTools: raw.piReadOnlyTools ?? ["read", "grep", "find", "ls"],
		reviewApi: raw.reviewApi === null ? null : { provider: "openai-codex", model: "gpt-5.5", reasoning: "high", ...raw.reviewApi },
		autoVerify: raw.autoVerify ?? true,
		reuseChecks: raw.reuseChecks ?? true,
		maxCorrectionRounds: raw.maxCorrectionRounds ?? 2,
		repoRulesFiles: raw.repoRulesFiles ?? ["AGENTS.md", "CLAUDE.md"],
		maxDiffBytes: raw.maxDiffBytes ?? 60_000,
		learning: { enabled: true, autoTuneEffort: true, autoRouteModels: true, minModelSamples: 20, ...raw.learning },
		supervisorProfiles: raw.supervisorProfiles ?? {},
		probeTtlMinutes: raw.probeTtlMinutes ?? 15,
		probeMaxTokens: raw.probeMaxTokens ?? 128,
		reviewMaxTokens: raw.reviewMaxTokens ?? 8192,
		workerMaxTurns,
		delegationTimeoutMinutes: raw.delegationTimeoutMinutes ?? 120,
		delegationBudgetUsd: raw.delegationBudgetUsd ?? 0,
		maxProcessOutputBytes: raw.maxProcessOutputBytes ?? 2_000_000,
		workerPermissionMode: raw.workerPermissionMode ?? "dontAsk",
		workerTools: raw.workerTools ?? ["Read", "Edit", "Write", "Glob", "Grep", "Bash"],
		workerAllowedTools,
		workerDisallowedTools: raw.workerDisallowedTools ?? [
			"Bash(git add *)", "Bash(git commit *)", "Bash(git push *)", "Bash(git merge *)",
			"Bash(git rebase *)", "Bash(git reset *)", "Bash(git checkout *)", "Bash(git switch *)",
			"Bash(git restore *)", "Bash(git clean *)", "Bash(git tag *)", "Bash(git cherry-pick *)",
			"Bash(git revert *)", "Bash(gh pr merge *)",
		],
		claudeReadOnlyTools: raw.claudeReadOnlyTools ?? ["Read", "Glob", "Grep"],
		claudeReadOnlyAllowedTools: raw.claudeReadOnlyAllowedTools ?? ["Read", "Glob", "Grep"],
		claudeReadOnlyDisallowedTools: raw.claudeReadOnlyDisallowedTools ?? ["Edit", "Write", "Bash(*)"],
		workerChains,
		defaultExecutionProfile: requestedDefault && PROFILE_NAMES.includes(requestedDefault) ? requestedDefault : "medium",
		independentReviewProfiles: validProfiles(raw.independentReviewProfiles ?? ["large", "critical"], "independentReviewProfiles", configPath),
		supervisorChain: (raw.supervisorChain ?? []).map(({ provider, model }) => ({ provider, model })),
		flagshipModels,
		supervisorEffort: { default: "medium", small: "medium", medium: "medium", large: "high", critical: "xhigh", ...raw.supervisorEffort },
		verificationCommands,
		verificationTimeoutMinutes: raw.verificationTimeoutMinutes ?? 20,
		supervisorAutoSelect: raw.supervisorAutoSelect ?? true,
		supervisorFailover: raw.supervisorFailover ?? true,
		probeOnActivate: raw.probeOnActivate ?? true,
		claudeProbeModel: raw.claudeProbeModel ?? "claude-haiku-4-5",
		creditHeadroom: headroom,
		exhaustedCooldownMinutes: raw.exhaustedCooldownMinutes ?? 60,
		unavailableCooldownMinutes: raw.unavailableCooldownMinutes ?? 24 * 60,
		transientRetryAttempts: raw.transientRetryAttempts ?? 4,
		transientRetryDelayMs: raw.transientRetryDelayMs ?? 5000,
		workerTimeoutMinutes: raw.workerTimeoutMinutes ?? 90,
		consultTimeoutMinutes: raw.consultTimeoutMinutes ?? 20,
		automaticSupervisorRecovery: raw.automaticSupervisorRecovery ?? true,
		recoveryMaxAgeMinutes: raw.recoveryMaxAgeMinutes ?? 120,
		contextWarningPercent: raw.contextWarningPercent ?? 40,
		allowedSupervisorProviders: raw.allowedSupervisorProviders ?? ["*"],
		supervisorTools: [...new Set([...(raw.supervisorTools ?? ["read", "edit", "write", "grep", "find", "ls", ...customTools]), "complete_task"])],
		maxOutputBytes: raw.maxOutputBytes ?? 51200,
		outputLimits,
		minImplementationGuideChars,
		contextPruning,
		reviewConcurrency: raw.reviewConcurrency ?? 3,
		reviewMaxShards: raw.reviewMaxShards ?? 8,
		auditShardBytes: raw.auditShardBytes ?? 300_000,
		auditMaxShards: raw.auditMaxShards ?? 6,
		reviewWholeFilesBytes: raw.reviewWholeFilesBytes ?? 100_000,
		reviewContextBytes: raw.reviewContextBytes ?? 24_000,
		workerCodeMapBytes: raw.workerCodeMapBytes ?? 10_000,
		tinyDelegationBytes: raw.tinyDelegationBytes ?? 8192,
		sensitivePaths: raw.sensitivePaths ?? {
			migration: { segments: ["migration", "migrations", "migrate"], extensions: [".sql"] },
			security: { segments: ["auth", "authn", "authz", "oauth", "crypto", "secrets", "credentials", "permissions", "acl", "security"], extensions: [".pem"] },
		},
	};
}

export function isAllowedSupervisor(ctx: ExtensionContext, config: Config): boolean {
	return Boolean(ctx.model && (config.allowedSupervisorProviders.includes("*") || config.allowedSupervisorProviders.includes(ctx.model.provider)));
}

/**
 * Worker effort for one delegation. The supervisor may raise it freely, but lowering it below the profile's
 * (possibly learned) effort is honored only for small tasks: a supervisor saving tokens must never cost quality.
 */
export function resolveEffort(requested: WorkerEffort | undefined, profileEffort: WorkerEffort | undefined, profile: ExecutionProfileName): WorkerEffort | undefined {
	if (!requested || !profileEffort) return requested ?? profileEffort;
	const lower = WORKER_EFFORTS.indexOf(requested) < WORKER_EFFORTS.indexOf(profileEffort);
	return lower && profile !== "small" ? profileEffort : requested;
}

export function modelDisplayName(ctx: ExtensionContext, provider: string, model: string): string {
	return ctx.modelRegistry.find(provider, model)?.name ?? model;
}

export function candidateLabel(candidate: WorkerCandidate): string {
	if (candidate.worker === "claude") return `Claude ${candidate.model}${candidate.effort ? `/${candidate.effort}` : ""}`;
	if (candidate.worker === "api") return `${candidate.provider} API ${candidate.model}`;
	return `Pi ${candidate.provider}/${candidate.model}${candidate.effort ? `/${candidate.effort}` : ""}`;
}

/** Model family, derived from the model id (one provider may serve several families, e.g. through Pi). */
export function modelFamily(candidate: WorkerCandidate): string {
	const id = candidate.model.toLowerCase();
	if (/claude|opus|sonnet|haiku|fable/.test(id)) return "anthropic";
	if (/gpt|codex|^o\d/.test(id)) return "openai";
	return candidate.provider ?? candidate.worker;
}

export type ConsultReviewer = "auto" | "claude" | "gpt";
export const CONSULT_FAMILIES: Record<Exclude<ConsultReviewer, "auto">, string> = { claude: "anthropic", gpt: "openai" };

export function workerHealthKeys(candidate: WorkerCandidate): string[] {
	if (candidate.worker === "claude") return ["claude-cli", `claude-cli:${claudeFamily(candidate.model)}`, `claude-cli:model:${candidate.model}`];
	// Pi workers and API reviewers share the Pi provider account (and its credits) with the supervisor.
	return [`pi:${candidate.provider}`, `pi:model:${candidate.provider}/${candidate.model}`];
}

export function supervisorHealthKeys(candidate: SupervisorCandidate): string[] {
	return [`pi:${candidate.provider}`, `pi:model:${candidate.provider}/${candidate.model}`];
}

/** The supervisor's preferred model family goes first; the rest of the chain stays as fallback, in order. */
export function orderChain(chain: WorkerCandidate[], prefer?: Exclude<ConsultReviewer, "auto">): WorkerCandidate[] {
	if (!prefer) return chain;
	const family = CONSULT_FAMILIES[prefer];
	return [...chain.filter((item) => modelFamily(item) === family), ...chain.filter((item) => modelFamily(item) !== family)];
}
