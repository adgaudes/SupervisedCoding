import { execFile as execFileCallback, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { StringEnum } from "@earendil-works/pi-ai";
import type { Model, Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	applyReading,
	availability,
	classifyFailure,
	claudeFamily,
	claudeLimitKey,
	FAILOVER_KINDS,
	formatUntil,
	markExhausted,
	markHealthy,
	parseResetHint,
	rankCandidates,
	readClaudeRateLimit,
	readLimitHeaders,
	type FailureKind,
	type FailureSignal,
	type HealthMap,
	type LimitReading,
	type RankedCandidate,
} from "./lib.ts";
import {
	addLesson,
	effectiveEffort,
	extractVerifyCommands,
	failureSignature,
	lessonsFor,
	loadLearning,
	parseVerdict,
	profileHint,
	profileStats,
	recordOutcome,
	removeLesson,
	updateLearning,
	tuneEfforts,
	type Effort,
	type LearningState,
	type ReviewVerdict,
	type VerificationResult,
} from "./learning.ts";
import { assessTask, routeWithEvidence, taskEffort, TASK_KINDS, type TaskAssessment } from "./routing.ts";
import { checkpoint, changesSince, type Checkpoint } from "./changes.ts";
import { formatOutline, formatReferences, outlineSupported, type ReferenceMatch } from "./outline.ts";

const execFile = promisify(execFileCallback);
const extensionDir = path.dirname(fileURLToPath(import.meta.url));
/**
 * User data and personal settings live in Pi's agent directory, outside the package, so installing or updating the
 * extension never overwrites them: <agent-dir>/supervised-coding/{config.json, learning.json, usage.jsonl, pi-sessions}.
 * config.json next to this file holds the defaults. Both paths are overridable so tests use scratch files.
 */
const userDir = path.join(process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent"), "supervised-coding");
const configPath = process.env.SUPERVISED_CODING_CONFIG ?? path.join(extensionDir, "config.json");
const userConfigPath = process.env.SUPERVISED_CODING_CONFIG ? undefined : path.join(userDir, "config.json");
const learningPath = process.env.SUPERVISED_CODING_DATA ?? path.join(userDir, "learning.json");

/** Earlier versions kept learning data inside the extension folder: copy it once to the user directory. */
function migrateLegacyData(): void {
	if (process.env.SUPERVISED_CODING_DATA) return;
	const legacyDir = path.join(extensionDir, "data");
	try {
		if (fs.existsSync(learningPath) || !fs.existsSync(path.join(legacyDir, "learning.json"))) return;
		fs.mkdirSync(userDir, { recursive: true });
		for (const name of ["learning.json", "usage.jsonl"]) {
			if (fs.existsSync(path.join(legacyDir, name))) fs.copyFileSync(path.join(legacyDir, name), path.join(userDir, name));
		}
	} catch {
		// The old data stays where it is; learning starts fresh rather than blocking the extension.
	}
}
const EXTENSION_NAME = "SupervisedCoding";
const STATE_TYPE = "supervised-coding";
const POLICY_TYPE = "supervised-coding-policy";
/** Entry types written by the extension before it was renamed; still read so existing sessions keep their state. */
const LEGACY_STATE_TYPES = ["codex-claude-supervisor"];
const CUSTOM_TOOLS = new Set(["plan_task", "complete_task", "consult_readonly", "delegate_implementation", "run_verification", "code_outline", "record_lesson", "supervisor_git", "request_git_commit", "request_git_push"]);
const PROFILE_NAMES = ["small", "medium", "large", "critical"] as const;
const WORKER_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const MAX_STORED_REPORT_CHARS = 8000;
/** data/usage.jsonl rotates to usage.jsonl.1 beyond this size, so the invocation log stays bounded. */
const USAGE_LOG_MAX_BYTES = 5 * 1024 * 1024;
const FLAGSHIP_YES = "Yes";
const FLAGSHIP_NO = "No";
/** Shell metacharacters that could chain or redirect commands in run_verification. */
const UNSAFE_COMMAND_CHARS = /[;&|`$<>\r\n%^()]/;
const assessmentSchema = Type.Object({
	kind: Type.Optional(StringEnum(TASK_KINDS)),
	risk: Type.Optional(StringEnum(["low", "medium", "high"] as const)),
	uncertainty: Type.Optional(StringEnum(["low", "medium", "high"] as const)),
	scope: Type.Optional(StringEnum(["local", "multi-file", "cross-system"] as const)),
}, { description: "Assess consequences, uncertainty and scope, not just line count. Security/concurrency/migrations and high risk require critical; architecture/high uncertainty require large. Omitted fields use conservative defaults." });

type WorkerEffort = "low" | "medium" | "high" | "xhigh" | "max";
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
type ExecutionProfileName = (typeof PROFILE_NAMES)[number];
/**
 * claude = Claude Code CLI; pi = any model configured in Pi (e.g. GPT through an OpenAI Codex subscription), run
 * through Pi's own CLI; api = a read-only reviewer called directly through a Pi provider (no CLI prompt overhead).
 * Every model can implement or review: roles follow the task, never the model family.
 */
type WorkerKind = "claude" | "pi" | "api";
type SessionWorker = "claude" | "pi";

interface WorkerCandidate {
	worker: WorkerKind;
	/** Model id (Claude Code model, or the model of the Pi provider). */
	model: string;
	effort?: WorkerEffort;
	/** Pi provider, for "pi" workers and "api" reviewers. */
	provider?: string;
	maxTurns?: number;
	maxBudgetUsd?: number;
}

interface SupervisorCandidate {
	provider: string;
	model: string;
}

interface Config {
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
}

interface OutputLimits {
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

const OUTPUT_LIMIT_DEFAULTS: OutputLimits = { verificationPassBytes: 2000, verificationFailBytes: 12_000, consultBytes: 24_000, workerReportBytes: 8000, outlineBytes: 24_000 };

interface SupervisorMetrics {
	delegations: number;
	resumedDelegations: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	costUsd: number;
	piRuns: number;
	providerFailovers: number;
	supervisorFailovers: number;
	readOnlyConsultations: number;
	claudeAttempts: number;
	gitInspectionBytes: number;
	flagshipRequests: number;
	flagshipApprovals: number;
	verifications: number;
	/** Checks answered from an earlier run on the same repository state instead of running again. */
	reusedChecks: number;
	correctionRounds: number;
	autoVerifiedDelegations: number;
	apiReviews: number;
	apiTokens: number;
	apiCostUsd: number;
	/** Worker/reviewer consumption per model in this conversation, keyed "<worker>:<model>". */
	byModel: Record<string, ModelUsage>;
	/** Tokens and cost per role (the supervisor is computed from the session itself). */
	byRole: Record<string, { tokens: number; costUsd: number }>;
	/** First utilization seen in this conversation per "<health key>|<window>", to show credits used. */
	limitStart: Record<string, number>;
	reviewVerdicts: Record<string, number>;
	firstPassDelegations: number;
	failedDelegations: number;
}

type UsageRole = "implement" | "correct" | "review" | "consult" | "probe";
type Billing = "subscription" | "api" | "unknown";

interface ModelUsage {
	worker: string;
	provider?: string;
	model: string;
	billing?: Billing;
	runs: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	costUsd: number;
}

interface WorkerSession {
	worker?: SessionWorker;
	sessionId: string;
	cwd: string;
	allowedPaths: string[];
	model: string;
	/** The task the session worked on: follow-up steps of the same task may resume it even on new paths. */
	taskId?: string;
}

type TaskPhase = "planned" | "implementing" | "implemented" | "reviewing" | "completed" | "failed";

interface TaskPacket {
	id: string;
	objective: string;
	profile: ExecutionProfileName;
	assessment?: TaskAssessment;
	verification?: VerificationResult;
	reviewVerdict?: ReviewVerdict;
	accepted?: boolean;
	implementationGuide: string;
	acceptanceCriteria: string[];
	allowedPaths: string[];
	phase: TaskPhase;
	primaryWorker?: string;
	lastReport?: string;
	/** Why the supervisor chose this profile (from plan_task). */
	rationale?: string;
	/** User prompt that created the task (see promptSeq). */
	promptSeq?: number;
	/** User answers to "use flagship model X?" for this task, keyed by model id; asked at most once per task. */
	flagshipDecisions?: Record<string, boolean>;
	/** Result of each VERIFY command when the task started: a check the task turned red is its regression. */
	baseline?: Record<string, boolean>;
	/**
	 * failureSignature of each VERIFY command that failed when the task started. A red check is tolerated only
	 * while it still fails the same way; tasks persisted before signatures existed get one at their next delegation.
	 */
	baselineSignatures?: Record<string, string>;
	/**
	 * Checks that regressed while verification was the task's only failure: once each passes again with
	 * run_verification, the task is implemented again. Undefined when anything else failed (worker, scope, review).
	 */
	failedChecks?: string[];
	delegationCount?: number;
	/** Strongest profile of any delegation of the task: review requirements follow it. */
	maxProfile?: ExecutionProfileName;
	/** What the last independent review covered: the whole task, or only the last delegation. */
	reviewScope?: "task" | "delegation";
	/** Implementer of the last delegation, so a task-level review can pick independent reviewers. */
	implementer?: WorkerCandidate;
	/** Paused with complete_task: it stops carrying its supervisor and effort into new prompts. */
	paused?: boolean;
	updatedAt: number;
}

interface PersistedState {
	enabled: boolean;
	toolsBeforeSupervisor?: string[];
	metrics?: SupervisorMetrics;
	workerSession?: WorkerSession;
	taskPacket?: TaskPacket;
	health?: HealthMap;
	supervisorMode?: "auto" | "manual";
	supervisorFlagshipGrant?: FlagshipGrant;
}

/** The user approved a flagship supervisor model for one task; it ends when that task ends or another task is planned. */
interface FlagshipGrant {
	taskId: string;
	provider: string;
	model: string;
}

interface RunResult {
	worker: WorkerKind;
	provider?: string;
	model: string;
	exitCode: number;
	output: string;
	stderr: string;
	errorMessage?: string;
	stopReason?: string;
	turns: number;
	sessionId?: string;
	costUsd: number;
	usage?: Usage;
	/** Structured provider hints used for failure classification. */
	signal: FailureSignal;
	limit?: LimitReading;
	/** Raw Claude Code `rate_limit_info` (rateLimitType, errorCode, windows) from the last rate_limit_event. */
	limitInfo?: Record<string, any>;
	/** How the run is paid: a subscription (plan usage) or a pay-per-use API key. */
	billing?: Billing;
	timedOut: boolean;
	/** The CLI stopped at the turn or cost limit the extension passed (--max-turns, --max-budget-usd). */
	limitHit?: "turns" | "budget";
	/** The output was cut off (e.g. an API review at its token limit): it is not a complete answer. */
	incomplete?: boolean;
}

/** Fresh metrics: nested maps must never be shared between sessions (a spread copy would share them). */
function freshMetrics(): SupervisorMetrics {
	return { ...EMPTY_METRICS, byModel: {}, byRole: {}, limitStart: {}, reviewVerdicts: {} };
}

const EMPTY_METRICS: SupervisorMetrics = {
	delegations: 0,
	resumedDelegations: 0,
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	costUsd: 0,
	piRuns: 0,
	providerFailovers: 0,
	supervisorFailovers: 0,
	readOnlyConsultations: 0,
	claudeAttempts: 0,
	gitInspectionBytes: 0,
	flagshipRequests: 0,
	flagshipApprovals: 0,
	verifications: 0,
	reusedChecks: 0,
	correctionRounds: 0,
	autoVerifiedDelegations: 0,
	apiReviews: 0,
	apiTokens: 0,
	apiCostUsd: 0,
	byModel: {},
	byRole: {},
	limitStart: {},
	reviewVerdicts: {},
	firstPassDelegations: 0,
	failedDelegations: 0,
};

/**
 * Starting quality order per profile (config.json normally overrides it). Claude Code leads where its harness
 * matters (per-command shell permissions, so the worker can run the tests itself); GPT through Pi alternates with
 * it on a different subscription, so one provider's limit never stops the work. Learning escalates or reorders
 * with evidence.
 */
const DEFAULT_WORKER_CHAINS: Record<ExecutionProfileName, WorkerCandidate[]> = {
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

type RawConfig = Partial<Config>;

/** Plain objects are merged one level deep (e.g. one profile of workerChains); arrays and scalars are replaced. */
function mergeConfig(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
	const merged: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(override)) {
		const current = merged[key];
		const plain = (item: unknown) => Boolean(item) && typeof item === "object" && !Array.isArray(item);
		merged[key] = plain(current) && plain(value) ? { ...(current as object), ...(value as object) } : value;
	}
	return merged;
}

function loadConfig(): Config {
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
	for (const field of ["maxDiffBytes", "maxOutputBytes", "maxProcessOutputBytes", "probeMaxTokens", "reviewMaxTokens"] as const) {
		const value = raw[field];
		if (value !== undefined && (!Number.isInteger(value) || value < 128)) throw new Error(`${field} must be an integer >= 128.`);
	}
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
		independentReviewProfiles: raw.independentReviewProfiles ?? ["large", "critical"],
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
		supervisorTools: [...new Set([...(raw.supervisorTools ?? ["read", "grep", "find", "ls", ...CUSTOM_TOOLS]), "complete_task"])],
		maxOutputBytes: raw.maxOutputBytes ?? 51200,
		outputLimits,
		minImplementationGuideChars,
	};
}

function isAllowedSupervisor(ctx: ExtensionContext, config: Config): boolean {
	return Boolean(ctx.model && (config.allowedSupervisorProviders.includes("*") || config.allowedSupervisorProviders.includes(ctx.model.provider)));
}

/** Resolve to a real executable: spawning `.cmd` shims with shell:false fails with EINVAL on current Node. */
function resolveClaudeCommand(configured: string): string {
	if (configured !== "claude" || process.platform !== "win32") return configured;
	const candidates = [
		process.env.APPDATA && path.join(process.env.APPDATA, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"),
		path.join(os.homedir(), ".local", "bin", "claude.exe"),
	].filter((item): item is string => Boolean(item));
	return candidates.find((item) => fs.existsSync(item)) ?? "claude";
}

/** Keep the end of long command output: test runners print failures and summaries last. */
function truncateUtf8Tail(value: string, maxBytes: number): string {
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
	return `[Output truncated; showing the last ${maxBytes} bytes.]\n${lastBytes(value, maxBytes)}`;
}

function truncateUtf8(value: string, maxBytes: number): string {
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
	return `${firstBytes(value, maxBytes)}\n\n[Output truncated; inspect the working tree for full details.]`;
}

/** Keep the start and the end of a long report: its context comes first, its conclusions (verdict, risks) last. */
function truncateUtf8Middle(value: string, maxBytes: number): string {
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
	const head = firstBytes(value, Math.floor(maxBytes * 0.4));
	return `${head}\n\n[… middle omitted …]\n\n${lastBytes(value, maxBytes - Buffer.byteLength(head, "utf8"))}`;
}

function firstBytes(value: string, maxBytes: number): string {
	let result = value.slice(0, maxBytes);
	while (Buffer.byteLength(result, "utf8") > maxBytes) result = result.slice(0, -1);
	return result;
}

function lastBytes(value: string, maxBytes: number): string {
	let result = value.slice(-maxBytes);
	while (Buffer.byteLength(result, "utf8") > maxBytes) result = result.slice(1);
	return result;
}

async function runGit(cwd: string, args: string[]): Promise<string> {
	try {
		const { stdout, stderr } = await execFile("git", args, { cwd, encoding: "utf8", maxBuffer: 5 * 1024 * 1024 });
		return `${stdout}${stderr}`.trim() || "(no output)";
	} catch (error) {
		const err = error as Error & { stdout?: string; stderr?: string };
		throw new Error(`${err.message}\n${err.stdout || ""}${err.stderr || ""}`.trim());
	}
}

async function safeRunGit(cwd: string, args: string[]): Promise<{ ok: true; output: string } | { ok: false; error: string }> {
	try {
		return { ok: true, output: await runGit(cwd, args) };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

function normalizeSupervisorPath(value: string): string {
	const normalized = value.trim().replace(/\\+/g, "/").replace(/^\.\//, "").replace(/\/+/g, "/");
	return normalized === "" ? "." : normalized;
}

function normalizeAllowedPaths(paths: string[], allowWorkspaceRoot = false): string[] {
	const result: string[] = [];
	for (const raw of paths) {
		const item = normalizeSupervisorPath(raw);
		if (path.isAbsolute(raw) || /^[A-Za-z]:/.test(raw)) throw new Error(`Path allowlist must be repository-relative: ${raw}`);
		if (item.split("/").includes("..")) throw new Error(`Path allowlist cannot contain '..': ${raw}`);
		if (item === "." && !allowWorkspaceRoot) throw new Error("Path allowlist cannot use '.' for normal delegation; list concrete files or directories.");
		if (!result.includes(item)) result.push(item);
	}
	return result;
}

function pathInAllowedScope(file: string, allowedPaths: string[]): boolean {
	const normalized = normalizeSupervisorPath(file);
	return allowedPaths.some((allowed) => allowed === "." || normalized === allowed || normalized.startsWith(`${allowed.replace(/\/$/, "")}/`));
}

interface GitSnapshot {
	available: boolean;
	status: string;
	branch?: string;
	head?: string;
	changedFiles: string[];
	stagedFiles: string[];
	/** Raw `git diff --cached` output, including index blob ids, to detect restaging of already-staged files. */
	stagedFingerprint?: string;
	fileHashes: Record<string, string>;
	error?: string;
}

/** Stdout only: stderr warnings (e.g. CRLF notices) must never be parsed as file names. */
async function gitStdout(cwd: string, args: string[]): Promise<string | undefined> {
	try {
		const { stdout } = await execFile("git", args, { cwd, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
		return stdout;
	} catch {
		return undefined;
	}
}

function nulSeparated(output: string | undefined): string[] {
	return output ? output.split("\0").filter(Boolean).map(normalizeSupervisorPath) : [];
}

function fileFingerprint(cwd: string, file: string): string {
	try {
		const absolute = path.join(cwd, file);
		const stat = fs.statSync(absolute);
		if (!stat.isFile()) return stat.isDirectory() ? "(directory)" : "(special)";
		return createHash("sha256").update(fs.readFileSync(absolute)).digest("hex");
	} catch {
		return "(missing)";
	}
}

async function getGitSnapshot(cwd: string): Promise<GitSnapshot> {
	const status = await safeRunGit(cwd, ["status", "--short", "--branch"]);
	if (!status.ok) return { available: false, status: `(git unavailable: ${status.error})`, changedFiles: [], stagedFiles: [], fileHashes: {}, error: status.error };
	const [branch, head, unstaged, staged, stagedRaw, untracked] = await Promise.all([
		safeRunGit(cwd, ["branch", "--show-current"]), gitStdout(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"]),
		gitStdout(cwd, ["diff", "--name-only", "--relative", "-z", "--"]), gitStdout(cwd, ["diff", "--cached", "--name-only", "--relative", "-z", "--"]),
		gitStdout(cwd, ["diff", "--cached", "--raw", "--no-renames", "--relative", "-z", "--"]), gitStdout(cwd, ["ls-files", "--others", "--exclude-standard", "-z", "--"]),
	]);
	const stagedFiles = nulSeparated(staged);
	const changedFiles = [...new Set([...nulSeparated(unstaged), ...stagedFiles, ...nulSeparated(untracked)])];
	const fileHashes: Record<string, string> = {};
	for (const file of changedFiles) fileHashes[file] = fileFingerprint(cwd, file);
	return {
		available: true,
		status: status.output,
		branch: branch.ok ? branch.output : undefined,
		head: head?.trim() || undefined,
		changedFiles,
		stagedFiles,
		stagedFingerprint: stagedRaw,
		fileHashes,
	};
}

const CLEAN_FINGERPRINT = "(clean)";

/**
 * Exact identity of the repository state a check runs on: HEAD, branch, index, and the content of every changed or
 * untracked file of the whole repository (a check run from a subdirectory may read files outside it). Files ignored
 * by Git are not covered. Undefined when it cannot be exact: no Git, or an entry that is not a plain file (a nested
 * repository, whose own changes Git does not list).
 */
async function workingTreeFingerprint(cwd: string): Promise<string | undefined> {
	const top = (await gitStdout(cwd, ["rev-parse", "--show-toplevel"]))?.trim();
	if (!top) return undefined;
	const [head, branch, index, status] = await Promise.all([
		gitStdout(top, ["rev-parse", "--verify", "--quiet", "HEAD"]), gitStdout(top, ["symbolic-ref", "--quiet", "HEAD"]),
		gitStdout(top, ["diff", "--cached", "--raw", "--no-renames", "-z", "--"]), gitStdout(top, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"]),
	]);
	if (index === undefined || status === undefined) return undefined;
	const hash = createHash("sha256").update(`${head ?? ""}\0${branch ?? ""}\0${index}`);
	for (const entry of status.split("\0").filter(Boolean)) {
		const content = fileFingerprint(top, entry.slice(3));
		if (content === "(directory)" || content === "(special)") return undefined;
		hash.update(`\0${entry}\0${content}`);
	}
	return hash.digest("hex");
}

/** Files whose content differs between two snapshots, including pre-existing dirty files. */
function filesChangedBetween(before: GitSnapshot, after: GitSnapshot): string[] {
	if (!before.available || !after.available) return [];
	return [...new Set([...before.changedFiles, ...after.changedFiles])].filter((file) => (before.fileHashes[file] ?? CLEAN_FINGERPRINT) !== (after.fileHashes[file] ?? CLEAN_FINGERPRINT));
}

function compareGitSnapshots(before: GitSnapshot, after: GitSnapshot, allowedPaths: string[]): string[] {
	if (!before.available || !after.available) return [];
	const outsideScope = filesChangedBetween(before, after).filter((file) => !pathInAllowedScope(file, allowedPaths));
	const violations: string[] = [];
	if (before.branch !== after.branch && (before.branch || after.branch)) {
		violations.push(`branch changed from ${before.branch ?? "(detached)"} to ${after.branch ?? "(detached)"}`);
	}
	if (before.head !== after.head && (before.head || after.head)) {
		violations.push(`HEAD changed from ${before.head ?? "(none)"} to ${after.head ?? "(none)"}`);
	}
	const beforeStaged = [...before.stagedFiles].sort().join("\n");
	const afterStaged = [...after.stagedFiles].sort().join("\n");
	if (beforeStaged !== afterStaged || before.stagedFingerprint !== after.stagedFingerprint) {
		violations.push(`staged files or staged content changed: ${after.stagedFiles.join(", ") || "none"}`);
	}
	if (outsideScope.length) violations.push(`files outside allowedPaths changed: ${outsideScope.join(", ")}`);
	return violations;
}

/**
 * Repository context for a fresh worker: instruction files (workers run in --safe-mode and would not load them)
 * and lessons learned in this repository. Resumed sessions already have it.
 */
function buildRepoContext(rules: string, lessons: string[]): string {
	const parts: string[] = [];
	if (rules) parts.push(`REPOSITORY RULES (follow them)\n${rules}`);
	if (lessons.length) parts.push(`LESSONS FROM PREVIOUS WORK IN THIS REPOSITORY (avoid repeating these mistakes)\n${lessons.map((item) => `- ${item}`).join("\n")}`);
	return parts.join("\n\n");
}

function buildWorkerPrompt(task: string, implementationGuide: string, acceptanceCriteria: string[], allowedPaths: string[], isContinuation: boolean, repoContext = ""): string {
	return `[CODING WORKER — ${isContinuation ? "TARGETED CORRECTION" : "EXECUTE, DO NOT REPLAN"}]
${!isContinuation && repoContext ? `${repoContext}\n\n` : ""}Implement only the task and file guide below. ${isContinuation ? "Reuse the existing session context; inspect only what changed or what the correction explicitly references." : "Check Git status first; preserve existing changes."} Never weaken, skip or delete tests to make checks pass. Start from the named symbols and use narrow/ranged reads where possible, expanding only when dependencies or uncertainty require it. Edit surgically and avoid broad exploration or unrelated refactors. Never stage, commit, push, merge, switch branches, rewrite history, or invoke agents. Do not modify paths outside the allowlist. If instructions conflict with the code or admit multiple material approaches, stop and report the ambiguity. Run pertinent checks. On success return only changed files, concise change summary, tests and residual risks; on failure include the diagnostics needed to resolve it.

TASK
${task}

FILE GUIDE (primary source of truth)
${implementationGuide}

ACCEPTANCE
${acceptanceCriteria.length ? acceptanceCriteria.map((item) => `- ${item}`).join("\n") : "- Task and repository requirements are satisfied."}

PATH ALLOWLIST
${allowedPaths.map((item) => `- ${item}`).join("\n")}`;
}

function handoffNote(previous: string, kind: FailureKind, partialFiles: string[], diff: string): string {
	if (!partialFiles.length) return `[HANDOFF] The previous worker (${previous}) stopped because of a provider failure (${kind}), not because of the task. It left no detectable file changes; start the task normally.`;
	return `[HANDOFF] The previous worker (${previous}) stopped because of a provider failure (${kind}), not because of the task. It partially edited: ${partialFiles.join(", ")}. Its changes are below: keep what is correct, fix what is incomplete, and finish the task.\n\n${diff}`;
}

/**
 * Directories whose instruction files apply to a delegation: the Git root, the working directory and every
 * directory from the root down to each authorized path (nested AGENTS.md/CLAUDE.md refine the root ones).
 */
function ruleDirs(cwd: string, gitRoot: string | undefined, allowedPaths: string[]): string[] {
	const root = path.resolve(gitRoot ?? cwd);
	const dirs = [root, path.resolve(cwd)];
	for (const item of allowedPaths) {
		let dir = path.resolve(cwd, item);
		try {
			if (!fs.statSync(dir).isDirectory()) dir = path.dirname(dir);
		} catch {
			dir = path.dirname(dir); // Not created yet: its parent directory's rules apply.
		}
		const chain: string[] = [];
		for (let current = dir; ; current = path.dirname(current)) {
			const relative = path.relative(root, current);
			if (relative.startsWith("..") || path.isAbsolute(relative)) break;
			chain.unshift(current);
			if (!relative) break;
		}
		dirs.push(...chain);
	}
	return [...new Set(dirs)];
}

/** Instruction files of the given directories, capped so they never dominate the prompt; omissions are reported. */
function readRepoRules(cwd: string, dirs: string[], files: string[], maxBytes = 12_000): string {
	const parts: string[] = [];
	const omitted: string[] = [];
	let total = 0;
	for (const dir of dirs) {
		for (const name of files) {
			const file = path.join(dir, name);
			try {
				if (!fs.statSync(file).isFile()) continue;
				const text = fs.readFileSync(file, "utf8").trim();
				if (!text) continue;
				const label = path.relative(cwd, file) || name;
				const remaining = maxBytes - total;
				if (remaining <= 200) {
					omitted.push(label);
					continue;
				}
				const clipped = truncateUtf8(text, remaining);
				parts.push(`[${label}]\n${clipped}`);
				total += Buffer.byteLength(clipped, "utf8");
			} catch {
				// Missing instruction files are normal.
			}
		}
	}
	if (omitted.length) parts.push(`[Rules omitted for size: ${omitted.join(", ")}. Read them before editing files they govern.]`);
	return parts.join("\n\n");
}

/**
 * Diff of the allowed paths against HEAD, plus the full content of new untracked files (git diff omits them).
 * Reviewers and handoffs get the actual change instead of having to reconstruct it.
 */
async function scopedDiff(cwd: string, paths: string[], maxBytes: number): Promise<string> {
	const scope = paths.length ? paths : ["."];
	const hasHead = Boolean((await gitStdout(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"]))?.trim());
	const tracked = (await gitStdout(cwd, ["-c", "core.quotepath=off", "diff", "--no-ext-diff", "--no-color", "--unified=5", ...(hasHead ? ["HEAD"] : []), "--", ...scope])) ?? "";
	const untracked = nulSeparated(await gitStdout(cwd, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...scope]));
	const added: string[] = [];
	for (const file of untracked) {
		try {
			const content = fs.readFileSync(path.join(cwd, file), "utf8");
			added.push(`diff --git a/${file} b/${file}\nnew file (untracked)\n+++ b/${file}\n${content.split("\n").map((line) => `+${line}`).join("\n")}`);
		} catch {
			added.push(`new file (untracked, unreadable): ${file}`);
		}
	}
	const diff = [tracked.trim(), ...added].filter(Boolean).join("\n");
	if (!diff) return "(no changes in the allowed paths)";
	return Buffer.byteLength(diff, "utf8") > maxBytes ? `${truncateUtf8(diff, maxBytes)}\n[Diff truncated at ${maxBytes} bytes: read the listed files for the rest.]` : diff;
}

function numberField(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function combineUsage(items: Array<Usage | undefined>): Usage | undefined {
	const values = items.filter((item): item is Usage => Boolean(item));
	if (!values.length) return undefined;
	const sum = (pick: (item: Usage) => number) => values.reduce((total, item) => total + pick(item), 0);
	const reasoningValues = values.filter((item) => item.reasoning !== undefined);
	const input = sum((item) => item.input);
	const output = sum((item) => item.output);
	const cacheRead = sum((item) => item.cacheRead);
	const cacheWrite = sum((item) => item.cacheWrite);
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		reasoning: reasoningValues.length ? reasoningValues.reduce((total, item) => total + (item.reasoning ?? 0), 0) : undefined,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: {
			input: sum((item) => item.cost.input),
			output: sum((item) => item.cost.output),
			cacheRead: sum((item) => item.cost.cacheRead),
			cacheWrite: sum((item) => item.cost.cacheWrite),
			total: sum((item) => item.cost.total),
		},
	};
}

function usageFromClaude(event: Record<string, any>, costUsd: number): Usage | undefined {
	const raw = event.usage;
	if (!raw || typeof raw !== "object") return undefined;
	const input = numberField(raw.input_tokens);
	const output = numberField(raw.output_tokens);
	const cacheRead = numberField(raw.cache_read_input_tokens);
	const cacheWrite = numberField(raw.cache_creation_input_tokens);
	return { input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: costUsd } };
}

const GUIDE_DEFAULTS: Record<string, string> = {
	SYMBOL: "SYMBOLS: the functions, classes and tests named in CHANGES.",
	PRESERVE: "PRESERVE:\n- Existing public API, behavior outside the task, formatting conventions and pre-existing changes.\n- Existing tests: never weaken, skip or delete them.",
};

/**
 * Validate a guide and return it ready for the worker. FILE, CHANGES and VERIFY carry the task and are required;
 * SYMBOLS and PRESERVE get conservative defaults instead of blocking, because a rejected delegation costs a whole
 * supervisor turn and the worker prompt already enforces preservation.
 */
function validateImplementationGuide(guide: string, allowedPaths: string[], minChars: number): { guide: string; defaulted: string[] } {
	const trimmed = guide.trim();
	if (trimmed.length < minChars) {
		throw new Error(`Delegation blocked: implementationGuide is too short (${trimmed.length}/${minChars} chars).`);
	}
	const has = (section: string) => new RegExp(`(^|\\n)\\s*${section}S?\\s*:`, "i").test(trimmed);
	const missing = ["FILE", "CHANGE", "VERIFY"].filter((section) => !has(section));
	if (missing.length) {
		throw new Error(`Delegation blocked: implementationGuide is missing required sections: ${missing.join(", ")}. Use FILE:, SYMBOLS:, CHANGES:, PRESERVE:, VERIFY:.`);
	}
	const absentPaths = allowedPaths.filter((file) => !trimmed.includes(file));
	if (absentPaths.length) {
		throw new Error(`Delegation blocked: every allowed path must appear in the file guide. Missing: ${absentPaths.join(", ")}`);
	}
	const defaulted = Object.keys(GUIDE_DEFAULTS).filter((section) => !has(section));
	return { guide: [trimmed, ...defaulted.map((section) => GUIDE_DEFAULTS[section])].join("\n"), defaulted };
}

interface ProcessOutcome {
	exitCode: number;
	stdout: string;
	stderr: string;
	aborted: boolean;
	timedOut: boolean;
}

/** Terminate the whole process tree: Windows does not propagate SIGTERM to grandchildren (shells, test runners). */
function killTree(child: ReturnType<typeof spawn>): void {
	if (child.exitCode !== null || child.signalCode !== null) return;
	if (process.platform === "win32" && child.pid) {
		spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => child.kill());
		return;
	}
	try { if (child.pid) process.kill(-child.pid, "SIGTERM"); else child.kill("SIGTERM"); } catch { child.kill("SIGTERM"); }
	setTimeout(() => {
		try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* Process group has already exited. */ }
	}, 5000).unref();
}

function runProcess(command: string, args: string[], input: string, cwd: string, signal: AbortSignal | undefined, timeoutMs: number, onLine?: (line: string) => void, options: { shell?: boolean; env?: Record<string, string>; maxBytes?: number } = {}): Promise<ProcessOutcome> {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let buffer = "";
		let aborted = false;
		let timedOut = false;
		let settled = false;
		const cap = options.maxBytes ?? 2_000_000;
		const child = spawn(command, args, { cwd, shell: options.shell ?? false, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...options.env } });
		const abort = () => {
			aborted = true;
			killTree(child);
		};
		const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs) : undefined;
		const finish = (code: number) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			if (onLine && buffer.trim()) onLine(buffer);
			resolve({ exitCode: code, stdout, stderr, aborted, timedOut });
		};
		child.stdout.on("data", (chunk) => {
			const text = chunk.toString();
			if (!onLine) {
				stdout = truncateUtf8Tail(stdout + text, cap);
				return;
			}
			buffer += text;
			if (Buffer.byteLength(buffer) > cap && !buffer.includes("\n")) { stderr += "Worker output line exceeded limit."; killTree(child); return; }
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) onLine(line);
		});
		child.stderr.on("data", (chunk) => { stderr = truncateUtf8Tail(stderr + chunk.toString(), cap); });
		child.on("error", (error) => { stderr += `spawn ${command} ${error.message}`; finish(1); });
		child.on("close", (code) => finish(code ?? 1));
		child.stdin.on("error", (error) => { stderr += error.message; });
		child.stdin.end(input);
		if (signal?.aborted) abort();
		else signal?.addEventListener("abort", abort, { once: true });
	});
}

type ClaudeMode = "edit" | "readonly" | "probe";

function claudeArgs(config: Config, candidate: WorkerCandidate, mode: ClaudeMode, resumeSessionId?: string): string[] {
	const args = [
		"--print", "--output-format", "stream-json", "--verbose",
		"--safe-mode", "--restricted", "--strict-mcp-config", "--disable-slash-commands",
		"--model", candidate.model,
		"--permission-prompts", "none",
	];
	if (candidate.effort) args.push("--effort", candidate.effort);
	args.push("--max-turns", String(candidate.maxTurns ?? (mode === "probe" ? 1 : mode === "readonly" ? 30 : 60)));
	if (candidate.maxBudgetUsd && candidate.maxBudgetUsd > 0) args.push("--max-budget-usd", String(candidate.maxBudgetUsd));
	if (mode === "edit") {
		args.push("--permission-mode", config.workerPermissionMode, "--tools", config.workerTools.join(","), "--allowedTools", config.workerAllowedTools.join(","));
		if (config.workerDisallowedTools.length) args.push("--disallowedTools", config.workerDisallowedTools.join(","));
	} else if (mode === "readonly") {
		args.push("--permission-mode", "dontAsk", "--tools", config.claudeReadOnlyTools.join(","), "--allowedTools", config.claudeReadOnlyAllowedTools.join(","));
		if (config.claudeReadOnlyDisallowedTools.length) args.push("--disallowedTools", config.claudeReadOnlyDisallowedTools.join(","));
	} else {
		args.push("--permission-mode", "dontAsk", "--tools", "");
	}
	if (resumeSessionId) args.push("--resume", resumeSessionId);
	return args;
}

async function runClaude(
	cwd: string,
	config: Config,
	candidate: WorkerCandidate,
	mode: ClaudeMode,
	prompt: string,
	resumeSessionId: string | undefined,
	signal: AbortSignal | undefined,
	timeoutMs: number,
	onProgress?: (text: string) => void,
): Promise<RunResult> {
	let output = "";
	let stopReason: string | undefined;
	let errorMessage: string | undefined;
	let sessionId: string | undefined;
	let turns = 0;
	let costUsd = 0;
	let usage: Usage | undefined;
	let errorCode: string | undefined;
	let httpStatus: number | undefined;
	let limit: LimitReading | undefined;
	let limitInfo: Record<string, any> | undefined;
	let billing: Billing = "unknown";
	let limitHit: RunResult["limitHit"];
	const outcome = await runProcess(resolveClaudeCommand(config.workerCommand), [...config.workerCommandArgs, ...claudeArgs(config, candidate, mode, resumeSessionId)], prompt, cwd, signal, timeoutMs, (line) => {
		if (!line.trim()) return;
		let event: Record<string, any>;
		try {
			event = JSON.parse(line) as Record<string, any>;
		} catch {
			return; // Claude Code reserves stdout for JSONL in stream-json mode.
		}
		if (event.type === "system" && event.subtype === "init") {
			sessionId = typeof event.session_id === "string" ? event.session_id : sessionId;
			if (typeof event.apiKeySource === "string") billing = event.apiKeySource === "none" ? "subscription" : "api";
		} else if (event.type === "rate_limit_event") {
			limit = readClaudeRateLimit(event.rate_limit_info) ?? limit;
			if (event.rate_limit_info && typeof event.rate_limit_info === "object") limitInfo = event.rate_limit_info;
		} else if (event.type === "assistant") {
			if (typeof event.error === "string") errorCode = event.error;
			const content = Array.isArray(event.message?.content) ? event.message.content : [];
			turns++;
			const text = content.filter((part: { type?: string }) => part.type === "text").map((part: { text?: string }) => part.text || "").join("\n");
			if (text) {
				output = text;
				onProgress?.(text);
			}
		} else if (event.type === "result") {
			if (typeof event.result === "string" && event.result) output = event.result;
			if (typeof event.num_turns === "number") turns = event.num_turns;
			stopReason = event.terminal_reason || event.stop_reason || stopReason;
			sessionId = event.session_id || sessionId;
			costUsd = numberField(event.total_cost_usd);
			usage = usageFromClaude(event, costUsd);
			if (typeof event.api_error_status === "number") httpStatus = event.api_error_status;
			if (event.is_error) errorMessage = String(event.result || event.api_error || event.subtype || "Claude Code reported an error.");
			if (event.subtype === "error_max_turns") limitHit = "turns";
			else if (event.subtype === "error_max_budget_usd") limitHit = "budget";
		}
	}, { maxBytes: config.maxProcessOutputBytes });
	if (outcome.aborted) { errorMessage = "Claude Code worker aborted."; stopReason = "aborted"; }
	if (outcome.timedOut) errorMessage = `Claude Code timed out after ${Math.round(timeoutMs / 60_000)} minutes.${errorMessage ? ` ${errorMessage}` : ""}`;
	const failureText = `${errorMessage ?? ""}\n${outcome.exitCode !== 0 ? outcome.stderr : ""}`;
	return {
		worker: "claude",
		model: candidate.model,
		exitCode: outcome.exitCode,
		output,
		stderr: outcome.stderr,
		errorMessage,
		stopReason,
		turns,
		sessionId,
		costUsd,
		usage,
		signal: { text: failureText, errorCode, httpStatus, rateLimitRejected: limit?.status === "exhausted" },
		limit,
		limitInfo,
		billing,
		timedOut: outcome.timedOut,
		limitHit,
	};
}

/**
 * Pi's CLI as node + script (a `.cmd` shim cannot be spawned without a shell on Windows). "pi" resolves to the
 * managed installation that runs this extension, as Pi's own launcher does.
 */
function resolvePiInvocation(configured: string): { command: string; prefix: string[] } {
	if (configured !== "pi") return { command: configured, prefix: [] };
	try {
		const installRoot = process.env.PI_MANAGED_INSTALL_ROOT ?? path.join(os.homedir(), ".pi", "agent", "install");
		const version = fs.readFileSync(path.join(installRoot, "current-version"), "utf8").trim();
		const packageDir = path.join(installRoot, "releases", version, "node_modules", "@earendil-works", "pi-coding-agent");
		const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8")) as { bin?: string | Record<string, string> };
		const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.pi;
		if (bin && fs.existsSync(path.join(packageDir, bin))) return { command: process.execPath, prefix: [path.join(packageDir, bin)] };
	} catch {
		// Not a managed installation: fall back to the command on PATH.
	}
	return { command: "pi", prefix: [] };
}

/**
 * One run of any Pi model through Pi's CLI in JSON mode. The session ID is chosen here, so a correction or a
 * retry resumes it with --session-id. Pi has no turn limit flag: the extension counts turns and stops the run.
 * Extensions (this one included), skills and context files are disabled: the prompt carries the repository rules.
 */
async function runPi(cwd: string, config: Config, candidate: WorkerCandidate, mode: "edit" | "readonly", prompt: string, resumeSessionId: string | undefined, signal: AbortSignal | undefined, timeoutMs: number, billing: Billing, onProgress?: (text: string) => void): Promise<RunResult> {
	const invocation = resolvePiInvocation(config.piCommand);
	const sessionId = resumeSessionId ?? randomUUID();
	const tools = mode === "edit" ? config.piWorkerTools : config.piReadOnlyTools;
	const args = [
		...invocation.prefix, ...config.piCommandArgs,
		"--mode", "json", "--model", `${candidate.provider}/${candidate.model}`,
		...(candidate.effort ? ["--thinking", candidate.effort] : []),
		"--no-extensions", "--no-skills", "--no-context-files", "--no-approve",
		"--tools", tools.join(","),
		"--session-dir", path.join(path.dirname(learningPath), "pi-sessions"),
		"--session-id", sessionId,
		"Carry out the instructions above.",
	];
	const turnLimit = new AbortController();
	const combined = signal ? AbortSignal.any([signal, turnLimit.signal]) : turnLimit.signal;
	let output = "";
	let turns = 0;
	let costUsd = 0;
	let stopReason: string | undefined;
	let errorMessage: string | undefined;
	let retryError: string | undefined;
	let model = candidate.model;
	const usages: Usage[] = [];
	const outcome = await runProcess(invocation.command, args, prompt, cwd, combined, timeoutMs, (line) => {
		let event: Record<string, any>;
		try {
			event = JSON.parse(line.replace(/\r$/, "")) as Record<string, any>;
		} catch {
			return; // Pi reserves stdout for JSONL; anything else is noise.
		}
		if (event.type === "turn_start") {
			turns++;
			if (candidate.maxTurns && turns > candidate.maxTurns) turnLimit.abort();
		} else if (event.type === "auto_retry_end" && event.success === false) {
			retryError = typeof event.finalError === "string" ? event.finalError : retryError;
		} else if (event.type === "message_end" && event.message?.role === "assistant") {
			const message = event.message as Record<string, any>;
			if (message.usage && typeof message.usage === "object") usages.push(message.usage as Usage);
			costUsd += numberField(message.usage?.cost?.total);
			if (typeof message.model === "string") model = message.model;
			stopReason = typeof message.stopReason === "string" ? message.stopReason : stopReason;
			errorMessage = stopReason === "error" || stopReason === "aborted" ? String(message.errorMessage || stopReason) : undefined;
			const text = (Array.isArray(message.content) ? message.content : []).filter((part: { type?: string }) => part.type === "text").map((part: { text?: string }) => part.text ?? "").join("\n").trim();
			if (text) {
				output = text;
				onProgress?.(text);
			}
		}
	}, { maxBytes: config.maxProcessOutputBytes });
	const turnLimitHit = turnLimit.signal.aborted && !signal?.aborted;
	if (turnLimitHit) errorMessage = `Pi worker stopped at the turn limit (${candidate.maxTurns} turns).`;
	else if (outcome.aborted) errorMessage = "Pi worker aborted.";
	if (outcome.timedOut) errorMessage = `Pi timed out after ${Math.round(timeoutMs / 60_000)} minutes.${errorMessage ? ` ${errorMessage}` : ""}`;
	if (!errorMessage && outcome.exitCode !== 0) errorMessage = retryError ?? (outcome.stderr.trim() || "Pi CLI failed.");
	const failureText = `${errorMessage ?? ""}\n${outcome.exitCode !== 0 ? outcome.stderr : ""}`;
	return {
		worker: "pi",
		provider: candidate.provider,
		model,
		exitCode: errorMessage ? outcome.exitCode || 1 : outcome.exitCode,
		output,
		stderr: outcome.stderr,
		errorMessage,
		stopReason,
		turns,
		sessionId,
		costUsd,
		usage: combineUsage(usages),
		signal: { text: failureText },
		billing,
		timedOut: outcome.timedOut,
		limitHit: turnLimitHit ? "turns" : undefined,
	};
}

function runFailed(result: RunResult): boolean {
	return result.exitCode !== 0 || Boolean(result.errorMessage) || result.timedOut;
}

/**
 * One run per distinct check: "npm test" / "npm run test" (also pnpm, yarn) resolve to their package.json script,
 * so "npm run test" and "node --test" are the same check when the script is "node --test". The first spelling wins.
 */
function dedupeVerifyCommands(cwd: string, commands: string[]): string[] {
	let scripts: Record<string, unknown> = {};
	try {
		scripts = (JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8")) as { scripts?: Record<string, unknown> }).scripts ?? {};
	} catch {
		// No package.json: every command is its own check.
	}
	const effective = (command: string) => {
		const match = /^(npm|pnpm|yarn)( run)? (\S+)$/.exec(command);
		if (!match || (match[1] === "npm" && !match[2] && match[3] !== "test")) return command;
		const script = scripts[match[3]];
		return typeof script === "string" ? script.trim().replace(/\s+/g, " ") : command;
	};
	const seen = new Set<string>();
	return commands.filter((command) => {
		const key = effective(command);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

/** The turn/cost limit the extension itself imposed stopped the run (structured subtype, else the error text). */
function executionLimit(result: RunResult): string | undefined {
	const text = runFailed(result) ? result.errorMessage ?? "" : "";
	const limit = result.limitHit ?? (/max[_ -]?turns|turn limit/i.test(text) ? "turns" : /max[_ -]?budget|budget limit/i.test(text) ? "budget" : undefined);
	return limit === "turns" ? "worker turn limit (--max-turns)" : limit === "budget" ? "worker cost limit (--max-budget-usd)" : undefined;
}

/** A hung process that produced nothing never got going (auth prompt, dead endpoint): treat as provider-side. */
function failureKindOf(result: RunResult): FailureKind {
	if (result.timedOut) return result.turns === 0 && !result.output ? "unavailable" : "task";
	return classifyFailure(result.signal);
}

/**
 * Worker effort for one delegation. The supervisor may raise it freely, but lowering it below the profile's
 * (possibly learned) effort is honored only for small tasks: a supervisor saving tokens must never cost quality.
 */
function resolveEffort(requested: WorkerEffort | undefined, profileEffort: WorkerEffort | undefined, profile: ExecutionProfileName): WorkerEffort | undefined {
	if (!requested || !profileEffort) return requested ?? profileEffort;
	const lower = WORKER_EFFORTS.indexOf(requested) < WORKER_EFFORTS.indexOf(profileEffort);
	return lower && profile !== "small" ? profileEffort : requested;
}

function modelDisplayName(ctx: ExtensionContext, provider: string, model: string): string {
	return ctx.modelRegistry.find(provider, model)?.name ?? model;
}

function candidateLabel(candidate: WorkerCandidate): string {
	if (candidate.worker === "claude") return `Claude ${candidate.model}${candidate.effort ? `/${candidate.effort}` : ""}`;
	if (candidate.worker === "api") return `${candidate.provider} API ${candidate.model}`;
	return `Pi ${candidate.provider}/${candidate.model}${candidate.effort ? `/${candidate.effort}` : ""}`;
}

/** Model family, derived from the model id (one provider may serve several families, e.g. through Pi). */
function modelFamily(candidate: WorkerCandidate): string {
	const id = candidate.model.toLowerCase();
	if (/claude|opus|sonnet|haiku|fable/.test(id)) return "anthropic";
	if (/gpt|codex|^o\d/.test(id)) return "openai";
	return candidate.provider ?? candidate.worker;
}

type ConsultReviewer = "auto" | "claude" | "gpt";
const CONSULT_FAMILIES: Record<Exclude<ConsultReviewer, "auto">, string> = { claude: "anthropic", gpt: "openai" };

function workerHealthKeys(candidate: WorkerCandidate): string[] {
	if (candidate.worker === "claude") return ["claude-cli", `claude-cli:${claudeFamily(candidate.model)}`, `claude-cli:model:${candidate.model}`];
	// Pi workers and API reviewers share the Pi provider account (and its credits) with the supervisor.
	return [`pi:${candidate.provider}`, `pi:model:${candidate.provider}/${candidate.model}`];
}

const SKIPPED_DIRS = new Set([".git", "node_modules", "dist", "build", "out", "coverage", ".venv", "__pycache__", "target", ".next"]);

/**
 * Text of the given paths for an API reviewer (directories expanded two levels, generated folders skipped).
 * Returns undefined when the material exceeds maxBytes: the CLI reviewer, which can browse, is used instead.
 */
function collectFiles(cwd: string, paths: string[], maxBytes: number): string | undefined {
	const parts: string[] = [];
	const seen = new Set<string>();
	let total = 0;
	const visit = (relative: string, depth: number): boolean => {
		const absolute = path.join(cwd, relative);
		let real: string;
		try { real = fs.realpathSync(absolute); } catch { return true; }
		const boundary = fs.realpathSync(cwd);
		if (!real.startsWith(boundary + path.sep) && real !== boundary) return false;
		if (seen.has(real)) return true;
		seen.add(real);
		let stat: fs.Stats;
		try {
			stat = fs.statSync(absolute);
		} catch {
			return true; // Deleted or not yet created: the diff shows it.
		}
		if (stat.isDirectory()) {
			if (depth > 30) return false;
			for (const entry of fs.readdirSync(absolute)) {
				if (SKIPPED_DIRS.has(entry)) continue;
				if (!visit(path.join(relative, entry), depth + 1)) return false;
			}
			return true;
		}
		if (!stat.isFile()) return true;
		if (stat.size + total > maxBytes) return false;
		const buffer = fs.readFileSync(absolute);
		if (buffer.includes(0)) return true; // Binary.
		total += buffer.length;
		if (total > maxBytes) return false;
		parts.push(`=== ${normalizeSupervisorPath(relative)} ===\n${buffer.toString("utf8")}`);
		return true;
	};
	for (const item of paths) if (!visit(item, 0)) return undefined;
	return parts.join("\n\n");
}

const OUTLINE_MAX_FILES = 200;

/**
 * Files to outline, inside the workspace: named files as given, directories expanded to the supported files Git
 * does not ignore (outside Git, a walk that skips generated folders).
 */
async function outlineFiles(cwd: string, paths: string[]): Promise<{ list: string[]; missing: string[]; capped: boolean }> {
	const boundary = fs.realpathSync(cwd);
	const list: string[] = [];
	const missing: string[] = [];
	const add = (file: string) => { if (!list.includes(file)) list.push(file); };
	for (const item of paths) {
		let real: string;
		let stat: fs.Stats;
		try {
			real = fs.realpathSync(path.join(cwd, item));
			stat = fs.statSync(real);
		} catch {
			missing.push(item);
			continue;
		}
		if (real !== boundary && !real.startsWith(boundary + path.sep)) throw new Error(`Path outside the workspace: ${item}`);
		if (!stat.isDirectory()) { add(item); continue; }
		const listed = await gitStdout(cwd, ["--literal-pathspecs", "ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", item]);
		const found = listed !== undefined ? nulSeparated(listed) : walkFiles(cwd, item);
		for (const file of found.filter(outlineSupported).sort()) {
			add(file);
			if (list.length > OUTLINE_MAX_FILES) return { list: list.slice(0, OUTLINE_MAX_FILES), missing, capped: true };
		}
	}
	return { list: list.slice(0, OUTLINE_MAX_FILES), missing, capped: list.length > OUTLINE_MAX_FILES };
}

/** Uses of each symbol, by whole-word name, in the files Git tracks or would track under the given paths. */
async function findReferences(cwd: string, symbols: string[], paths: string[]): Promise<string> {
	if (!(await gitStdout(cwd, ["rev-parse", "--show-toplevel"]))) throw new Error("References need a Git repository.");
	const parts: string[] = [];
	for (const raw of symbols) {
		const symbol = raw.trim();
		if (!/^[\w$]+(?:\.[\w$]+)*$/.test(symbol)) throw new Error(`Not a symbol name: ${raw}`);
		// A qualified name (Store.add) is searched by its last part: calls rarely spell the qualifier.
		const name = symbol.split(".").at(-1)!;
		// Exit code 1 (no match) reads as no output.
		const output = await gitStdout(cwd, ["-c", "core.quotepath=off", "--literal-pathspecs", "grep", "--untracked", "-I", "-n", "-z", "-w", "-F", "--no-color", "-e", name, "--", ...paths]);
		const matches: ReferenceMatch[] = [];
		for (const line of (output ?? "").split("\n").filter(Boolean)) {
			const [file, number, ...text] = line.split("\0");
			if (file && number) matches.push({ file: normalizeSupervisorPath(file), line: Number(number), text: text.join("\0") });
		}
		const sources: Record<string, string | undefined> = {};
		for (const file of new Set(matches.slice(0, 60).map((match) => match.file))) {
			if (!outlineSupported(file)) continue;
			try { sources[file] = fs.readFileSync(path.join(cwd, file), "utf8"); } catch { /* Deleted meanwhile. */ }
		}
		parts.push(formatReferences(symbol, matches, sources));
	}
	return parts.join("\n\n");
}

function walkFiles(cwd: string, relative: string, depth = 0): string[] {
	if (depth > 30) return [];
	const files: string[] = [];
	for (const entry of fs.readdirSync(path.join(cwd, relative), { withFileTypes: true })) {
		if (SKIPPED_DIRS.has(entry.name)) continue;
		const child = relative === "." ? entry.name : `${relative}/${entry.name}`;
		if (entry.isDirectory()) files.push(...walkFiles(cwd, child, depth + 1));
		else if (entry.isFile()) files.push(child);
	}
	return files;
}

/** Read-only review through a Pi provider: only the diff and files are sent, without a CLI's fixed prompt overhead. */
async function runApiReview(ctx: ExtensionContext, candidate: WorkerCandidate, reasoning: ThinkingLevel, prompt: string, material: string, signal: AbortSignal | undefined, timeoutMs: number, maxTokens = 8192): Promise<RunResult> {
	const base = { worker: "api" as const, provider: candidate.provider, model: candidate.model, stderr: "", turns: 1, timedOut: false };
	const model = ctx.modelRegistry.find(candidate.provider ?? "", candidate.model);
	if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) {
		const errorMessage = `model not available in Pi: ${candidate.provider}/${candidate.model}`;
		return { ...base, exitCode: 1, output: "", errorMessage, costUsd: 0, signal: { text: errorMessage, httpStatus: 404 } };
	}
	const controller = new AbortController();
	const onAbort = () => controller.abort();
	signal?.addEventListener("abort", onAbort, { once: true });
	if (signal?.aborted) controller.abort();
	let timedOut = false;
	const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs) : undefined;
	try {
		const content = `${prompt}\n\nFILES (current content)\n${material || "(none)"}`;
		const message = await ctx.modelRegistry.streamSimple(model, { messages: [{ role: "user", content, timestamp: Date.now() }] }, { reasoning: reasoning === "off" ? undefined : reasoning, signal: controller.signal, maxTokens }).result();
		const text = message.content.filter((part): part is { type: "text"; text: string } => part.type === "text").map((part) => part.text).join("\n").trim();
		// A truncated review is not a provider failure, but it is no verdict either: the next reviewer runs.
		const incomplete = message.stopReason === "length";
		const output = incomplete ? `${text}\n[Review output limit reached; review is incomplete.]` : text;
		const errorMessage = message.stopReason === "error" || message.stopReason === "aborted" ? message.errorMessage ?? (timedOut ? `API review timed out after ${Math.round(timeoutMs / 60_000)} minutes.` : "API review failed.") : undefined;
		const billing: Billing = ctx.modelRegistry.isUsingOAuth(model) ? "subscription" : "api";
		return { ...base, exitCode: errorMessage ? 1 : 0, output, errorMessage, costUsd: numberField(message.usage?.cost?.total), usage: message.usage, signal: { text: errorMessage ?? "" }, timedOut, turns: output ? 1 : 0, billing, incomplete };
	} catch (error) {
		return { ...base, exitCode: 1, output: "", costUsd: 0, timedOut, turns: 0, errorMessage: String(error), signal: { text: String(error) } };
	} finally {
		if (timer) clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}

function supervisorHealthKeys(candidate: SupervisorCandidate): string[] {
	return [`pi:${candidate.provider}`, `pi:model:${candidate.provider}/${candidate.model}`];
}

async function waitForRetry(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
	if (signal?.aborted) throw new Error("Operation aborted.");
	await new Promise<void>((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error("Operation aborted."));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, delayMs);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

interface AttemptRecord {
	label: string;
	ok: boolean;
	kind?: FailureKind;
	detail?: string;
	/** Position in the configured chain, so reports list candidates in chain order (blocked ones included). */
	order?: number;
}

/** Attempts in chain order: blocked candidates are collected first but must appear where they sit in the chain. */
function inChainOrder(attempts: AttemptRecord[]): AttemptRecord[] {
	return [...attempts].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

interface ImplementationSpec {
	task: string;
	guide: string;
	criteria: string[];
	allowedPaths: string[];
	profileName: ExecutionProfileName;
	preferWorker?: Exclude<ConsultReviewer, "auto">;
	/** Supervisor override of the profile's Claude effort for this delegation. */
	effort?: WorkerEffort;
	resumeSessionId?: string;
	resumeWorker?: SessionWorker;
	resumeModel?: string;
	assessment?: TaskAssessment;
	candidates?: WorkerCandidate[];
	handoff?: string;
	role?: UsageRole;
	checkpoint?: Checkpoint;
	/** Whole prompt for a resumed session, which already holds guide and context; fresh candidates get guide and handoff. */
	resumePrompt?: string;
	/** Repository rules and lessons for fresh workers. */
	repoContext?: string;
}

interface ImplementationOutcome {
	failed: boolean;
	final?: RunResult;
	finalCandidate?: WorkerCandidate;
	primaryOutput: string;
	attempts: AttemptRecord[];
	usage: Array<Usage | undefined>;
	before: GitSnapshot;
	after: GitSnapshot;
	scopeViolations: string[];
	resumed: boolean;
	/** The worker stopped at an execution limit (turns, cost, delegation time); its session and edits are kept. */
	limitReached?: string;
}

interface ConsultOutcome {
	failed: boolean;
	text: string;
	reviewer?: string;
	attempts: AttemptRecord[];
	usage: Array<Usage | undefined>;
	violations: string[];
	gitAvailable: boolean;
	verdict: ReviewVerdict;
}

/** The supervisor's preferred model family goes first; the rest of the chain stays as fallback, in order. */
function orderChain(chain: WorkerCandidate[], prefer?: Exclude<ConsultReviewer, "auto">): WorkerCandidate[] {
	if (!prefer) return chain;
	const family = CONSULT_FAMILIES[prefer];
	return [...chain.filter((item) => modelFamily(item) === family), ...chain.filter((item) => modelFamily(item) !== family)];
}

function describeBlocked(blocked: RankedCandidate<WorkerCandidate>[]): string {
	return blocked.map((item) => `${candidateLabel(item.candidate)} until ${formatUntil(item.until)}${item.reason ? ` (${item.reason})` : ""}`).join("; ");
}

function findLastAssistantError(messages: unknown[]): { errorMessage: string; provider?: string; model?: string } | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const entry = messages[index] as Record<string, any>;
		const message = entry?.type === "message" ? entry.message : entry;
		if (message?.role !== "assistant") continue;
		return message.stopReason === "error" && message.errorMessage ? { errorMessage: String(message.errorMessage), provider: message.provider, model: message.model } : undefined;
	}
	return undefined;
}

export default function supervisedCoding(pi: ExtensionAPI): void {
	migrateLegacyData();
	const config = loadConfig();
	let enabled = false;
	let toolsBeforeSupervisor: string[] | undefined;
	let metrics: SupervisorMetrics = freshMetrics();
	let workerSession: WorkerSession | undefined;
	let taskPacket: TaskPacket | undefined;
	let health: HealthMap = {};
	let supervisorMode: "auto" | "manual" = config.supervisorAutoSelect ? "auto" : "manual";
	let policyInjected = false;
	let lastUserPrompt = "";
	let supervisorRecoveryRunning = false;
	let pendingRecoveryTask: string | undefined;
	let supervisorFailoversThisRun = 0;
	let settingModel = false;
	let supervisorFlagshipGrant: FlagshipGrant | undefined;
	/** Incremented per user prompt: delegations of one prompt form one task unless plan_task/continuePrevious say otherwise. */
	let promptSeq = 0;
	/** An unfinished task that keeps its supervisor model and effort into the current prompt (see drivesThisPrompt). */
	let carriedTaskId: string | undefined;
	let delegationRunning = false;
	let activeBudget: { spent: number; deadline: number } | undefined;
	let unknownUsageRuns = 0;
	const lastLimitHeaders: Record<string, Record<string, string>> = {};
	// Learning is global (across sessions and projects), stored next to the extension, never in the session log.
	let learning: LearningState = loadLearning(learningPath);
	const gitRoots = new Map<string, string | undefined>();

	async function mutateLearning(ctx: ExtensionContext, mutate: (state: LearningState) => void): Promise<void> {
		try {
			learning = await updateLearning(learningPath, mutate);
		} catch (error) {
			ctx.ui.notify(`${EXTENSION_NAME}: could not save learning data (${error instanceof Error ? error.message : String(error)}).`, "warning");
		}
	}

	async function gitRoot(cwd: string): Promise<string | undefined> {
		if (!gitRoots.has(cwd)) gitRoots.set(cwd, (await gitStdout(cwd, ["rev-parse", "--show-toplevel"]))?.trim() || undefined);
		return gitRoots.get(cwd);
	}

	/** Lessons and statistics are kept per repository (Git root, or the working directory outside Git). */
	async function repoKey(cwd: string): Promise<string> {
		const root = (await gitRoot(cwd)) ?? cwd;
		const normalized = path.resolve(root).replace(/\\/g, "/");
		return process.platform === "win32" ? normalized.toLowerCase() : normalized;
	}

	async function repoContextFor(cwd: string, allowedPaths: string[]): Promise<string> {
		learning = loadLearning(learningPath);
		const rules = readRepoRules(cwd, ruleDirs(cwd, await gitRoot(cwd), allowedPaths), config.repoRulesFiles);
		const lessons = config.learning.enabled ? lessonsFor(learning, await repoKey(cwd)).map((item) => item.text) : [];
		return buildRepoContext(rules, lessons);
	}

	const cooldownMs = () => config.exhaustedCooldownMinutes * 60_000;
	/** A "pi" worker or reviewer: only models Pi knows and can authenticate; billing as Pi reports it for that model. */
	async function runPiWorker(ctx: ExtensionContext, candidate: WorkerCandidate, mode: "edit" | "readonly", prompt: string, resumeSessionId: string | undefined, signal: AbortSignal | undefined, timeoutMs: number, onProgress?: (text: string) => void): Promise<RunResult> {
		const model = ctx.modelRegistry.find(candidate.provider ?? "", candidate.model);
		if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) {
			const errorMessage = `model not available in Pi: ${candidate.provider}/${candidate.model}`;
			return { worker: "pi", provider: candidate.provider, model: candidate.model, exitCode: 1, output: "", stderr: "", errorMessage, turns: 0, costUsd: 0, signal: { text: errorMessage, httpStatus: 404 }, timedOut: false };
		}
		return runPi(ctx.cwd, config, candidate, mode, prompt, resumeSessionId, signal, timeoutMs, ctx.modelRegistry.isUsingOAuth(model) ? "subscription" : "api", onProgress);
	}

	/** Minutes → milliseconds; 0 stays 0 ("no timeout" for runProcess). */
	const minutes = (value: number) => (value > 0 ? value * 60_000 : 0);

	/**
	 * The delegation's cumulative time/cost limit. It is checked only between phases (before an attempt, a correction
	 * round or the review): a running worker is never killed for it, so its session stays resumable.
	 */
	function budgetExceeded(): string | undefined {
		if (!activeBudget) return undefined;
		if (Date.now() >= activeBudget.deadline) return `delegation time limit (${config.delegationTimeoutMinutes} min)`;
		if (config.delegationBudgetUsd > 0 && activeBudget.spent >= config.delegationBudgetUsd) return `delegation cost limit ($${config.delegationBudgetUsd})`;
		return undefined;
	}

	function statusText(ctx: ExtensionContext): string {
		const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no model";
		const task = openTask() ? ` · ${taskPacket?.profile}` : "";
		return `${EXTENSION_NAME} ${model}/${pi.getThinkingLevel()}${supervisorMode === "auto" ? " (auto)" : ""}${task} · C${metrics.claudeAttempts} P${metrics.piRuns} · ${metrics.providerFailovers + metrics.supervisorFailovers} failovers`;
	}

	function updateStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus(STATE_TYPE, ctx.ui.theme.fg("accent", statusText(ctx)));
	}

	/** Remember the first utilization seen per limit window in this conversation (to show credits consumed). */
	function noteLimitBaselines(): void {
		for (const [key, item] of Object.entries(health)) {
			for (const [window, data] of Object.entries(item.windows ?? {})) {
				if (data.utilization !== undefined && metrics.limitStart[`${key}|${window}`] === undefined) metrics.limitStart[`${key}|${window}`] = data.utilization;
			}
		}
	}

	function persist(): void {
		noteLimitBaselines();
		pi.appendEntry(STATE_TYPE, { enabled, toolsBeforeSupervisor, metrics, workerSession, taskPacket, health, supervisorMode, supervisorFlagshipGrant } satisfies PersistedState);
	}

	/** The current task, if it is still open (planned or in progress and not completed). */
	function openTask(): TaskPacket | undefined {
		return taskPacket && taskPacket.phase !== "completed" ? taskPacket : undefined;
	}

	/**
	 * Whether a task sets supervisor model and effort in the current prompt: it was created or continued in this
	 * prompt, or it was left unfinished (planned, failed, interrupted) when the prompt started. A task that is
	 * implemented but not accepted, or paused, does not carry over: an unrelated request must start conservatively.
	 */
	function drivesThisPrompt(task: TaskPacket | undefined): boolean {
		return Boolean(task && (task.promptSeq === promptSeq || task.id === carriedTaskId));
	}

	function carriesOver(task: TaskPacket | undefined): boolean {
		return Boolean(task && !task.paused && ["planned", "failed", "implementing", "reviewing"].includes(task.phase));
	}

	function isFlagship(model: string): boolean {
		return config.flagshipModels.includes(model);
	}

	/**
	 * Ask the user before using a flagship model. The answer is remembered for the current task, so failovers,
	 * corrections and follow-up delegations of the same task never ask twice. Without a UI the answer is always no.
	 */
	async function approveFlagship(ctx: ExtensionContext, model: string, name: string): Promise<boolean> {
		const decided = openTask()?.flagshipDecisions?.[model];
		if (decided !== undefined) return decided;
		if (!ctx.hasUI) return false;
		metrics.flagshipRequests++;
		const answer = await ctx.ui.select(`${name} would be more useful for this task. Use it?`, [FLAGSHIP_YES, FLAGSHIP_NO]);
		const approved = answer === FLAGSHIP_YES;
		if (approved) metrics.flagshipApprovals++;
		if (openTask() && taskPacket) taskPacket = { ...taskPacket, flagshipDecisions: { ...taskPacket.flagshipDecisions, [model]: approved }, updatedAt: Date.now() };
		persist();
		return approved;
	}

	/** Supervisor reasoning effort follows the open task's profile; without a task it drops back to the default. */
	function applySupervisorEffort(profile?: ExecutionProfileName): void {
		const current = openTask();
		const level = config.supervisorEffort[profile ?? (drivesThisPrompt(current) ? current!.profile : "default")] ?? config.supervisorEffort.default;
		if (pi.getThinkingLevel() !== level) pi.setThinkingLevel(level);
	}

	function recordRun(result: RunResult, role: UsageRole): void {
		if (activeBudget) activeBudget.spent += result.costUsd;
		// Only invocations that ran count: a candidate that never started (missing model, spawn error) consumed nothing.
		if (!result.usage && (result.turns > 0 || result.output || result.timedOut)) unknownUsageRuns++;
		try {
			const usageLog = path.join(path.dirname(learningPath), "usage.jsonl");
			fs.mkdirSync(path.dirname(learningPath), { recursive: true });
			try {
				if (fs.statSync(usageLog).size > USAGE_LOG_MAX_BYTES) fs.renameSync(usageLog, `${usageLog}.1`);
			} catch { /* No log yet. */ }
			fs.appendFileSync(usageLog, JSON.stringify({ at: Date.now(), taskId: taskPacket?.id, role, worker: result.worker, provider: result.provider, model: result.model, billing: result.billing ?? "unknown", usage: result.usage, costUsd: result.costUsd, measured: Boolean(result.usage), failed: runFailed(result), timedOut: result.timedOut }) + "\n");
		} catch { /* Telemetry must never stop implementation. */ }
		recordModelRun(result, role);
	}

	function recordModelRun(result: RunResult, role: UsageRole): void {
		const usage = result.usage;
		const key = `${result.worker}:${result.provider ?? "cli"}:${result.model || "default"}:${result.billing ?? "unknown"}`;
		const entry = (metrics.byModel[key] ??= { worker: result.worker, provider: result.provider, model: result.model || "default", runs: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 });
		entry.runs++;
		if (result.billing) entry.billing = result.billing;
		entry.input += usage?.input ?? 0;
		entry.output += usage?.output ?? 0;
		entry.cacheRead += usage?.cacheRead ?? 0;
		entry.cacheWrite += usage?.cacheWrite ?? 0;
		entry.costUsd += result.costUsd;
		const roleEntry = (metrics.byRole[role] ??= { tokens: 0, costUsd: 0 });
		roleEntry.tokens += (usage?.input ?? 0) + (usage?.output ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0);
		roleEntry.costUsd += result.costUsd;
		if (result.worker === "claude") {
			metrics.claudeAttempts++;
			metrics.costUsd += result.costUsd;
			metrics.inputTokens += result.usage?.input ?? 0;
			metrics.outputTokens += result.usage?.output ?? 0;
			metrics.cacheReadTokens += result.usage?.cacheRead ?? 0;
			metrics.cacheWriteTokens += result.usage?.cacheWrite ?? 0;
		} else if (result.worker === "api") {
			if (role === "review") metrics.apiReviews++;
			metrics.apiTokens += result.usage?.totalTokens ?? 0;
			metrics.apiCostUsd += result.costUsd;
		} else {
			metrics.piRuns++;
		}
	}

	/** Update provider health from a finished worker run: limit readings on success, exhaustion markers on provider failures. */
	function recordWorkerHealth(candidate: WorkerCandidate, result: RunResult, kind: FailureKind | undefined): void {
		const now = Date.now();
		const source = `${candidateLabel(candidate)} run`;
		const providerKey = candidate.worker === "claude" ? "claude-cli" : `pi:${candidate.provider}`;
		const accountKey = candidate.worker === "claude" ? claudeLimitKey(result.limitInfo, candidate.model) : providerKey;
		if (result.limit) applyReading(health, accountKey, result.limit, source, cooldownMs(), now);
		if (!kind) {
			markHealthy(health, workerHealthKeys(candidate).at(-1) as string, source, now);
			if (!result.limit) markHealthy(health, accountKey, source, now);
			return;
		}
		const reason = (result.errorMessage || result.stderr || kind).trim();
		if (kind === "credits") {
			markExhausted(health, accountKey, reason, parseResetHint(reason, now) ?? result.limit?.resetsAt ?? now + cooldownMs(), source, now);
		} else if (kind === "auth") {
			markExhausted(health, providerKey, `auth: ${reason}`, now + cooldownMs(), source, now);
		} else if (kind === "unavailable") {
			markExhausted(health, workerHealthKeys(candidate).at(-1) as string, `unavailable: ${reason}`, now + minutes(config.unavailableCooldownMinutes), source, now);
		}
	}

	function updateTaskPacket(patch: Partial<TaskPacket>): void {
		if (!taskPacket) return;
		const lastReport = patch.lastReport !== undefined ? patch.lastReport.slice(-MAX_STORED_REPORT_CHARS) : taskPacket.lastReport;
		taskPacket = { ...taskPacket, ...patch, lastReport, updatedAt: Date.now() };
		persist();
	}

	interface CheckResult {
		command: string;
		ok: boolean;
		exitCode: number;
		timedOut: boolean;
		output: string;
		changed: string[];
		/** failureSignature of a failed run, including its exit status. */
		signature?: string;
		/** Branch, HEAD or index changes made by the check: never harmless, unlike files it writes. */
		safetyViolations: string[];
		/** Answered from an earlier run on the same repository state (see runCheck). */
		reused?: boolean;
	}

	/**
	 * Last result of each command, with the repository state it ran on. Within one user prompt only workers change
	 * files (the supervisor has no shell, consultants and reviewers are read-only), so the same state gives the same
	 * result: the next delegation's start need not run again the checks that closed the previous one. Results are
	 * dropped whenever a worker starts, since a worker may also write files ignored by Git, which the fingerprint
	 * does not cover. Only runs that left the state as they found it are kept.
	 */
	const checkResults = new Map<string, { cwd: string; promptSeq: number; fingerprint: string; result: CheckResult }>();

	function checkReuseEnabled(): boolean {
		return config.reuseChecks && !config.supervisorTools.includes("bash");
	}

	/** pass; unchanged = red since the task started and failing the same way; changed/regression block the task. */
	type CheckState = "pass" | "unchanged" | "changed" | "regression";

	/**
	 * How a check compares with the task's start. A check red since then is tolerated only while its failure
	 * signature matches the one recorded then: a new failure inside an already-red command (another test, a
	 * different error, other counts) is a regression. Without a recorded signature nothing proves the failure
	 * unchanged, so it counts as changed.
	 */
	function classifyCheck(check: CheckResult, redAtStart: boolean, startSignature: string | undefined): CheckState {
		if (check.ok) return "pass";
		if (!redAtStart) return "regression";
		return startSignature !== undefined && check.signature === startSignature ? "unchanged" : "changed";
	}

	/**
	 * One allowlisted check, non-interactive (CI=1 keeps test runners out of watch mode). With reuse, a result from
	 * this prompt on exactly the same repository state is returned instead of running the command again.
	 */
	async function runCheck(ctx: ExtensionContext, command: string, signal: AbortSignal | undefined, reuse = false): Promise<CheckResult> {
		const fingerprint = checkReuseEnabled() ? await workingTreeFingerprint(ctx.cwd) : undefined;
		const known = checkResults.get(command);
		if (reuse && fingerprint && known && known.fingerprint === fingerprint && known.cwd === ctx.cwd && known.promptSeq === promptSeq) {
			metrics.reusedChecks++;
			return { ...known.result, changed: [], safetyViolations: [], reused: true };
		}
		const before = await getGitSnapshot(ctx.cwd);
		const outcome = await runProcess(command, [], "", ctx.cwd, signal, minutes(config.verificationTimeoutMinutes), undefined, { shell: true, maxBytes: config.maxProcessOutputBytes, env: { CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" } });
		if (outcome.aborted) throw new Error("Verification aborted.");
		const afterRun = await getGitSnapshot(ctx.cwd);
		metrics.verifications++;
		const ok = outcome.exitCode === 0 && !outcome.timedOut;
		const output = `${outcome.stdout}${outcome.stderr ? `\n[stderr]\n${outcome.stderr}` : ""}`.trim() || "(no output)";
		const result: CheckResult = {
			command,
			ok,
			exitCode: outcome.exitCode,
			timedOut: outcome.timedOut,
			output,
			changed: filesChangedBetween(before, afterRun),
			// Every path is in scope here ("."), so only branch, HEAD and staged-content changes are reported.
			safetyViolations: compareGitSnapshots(before, afterRun, ["."]),
			signature: ok ? undefined : failureSignature(`${outcome.timedOut ? "timed out" : `exit code ${outcome.exitCode}`}\n${output}`),
		};
		// A timeout says nothing stable about the code; a run that changed the state is valid for no state left.
		const after = fingerprint && !outcome.timedOut && !result.changed.length && !result.safetyViolations.length ? await workingTreeFingerprint(ctx.cwd) : undefined;
		if (after && after === fingerprint) checkResults.set(command, { cwd: ctx.cwd, promptSeq, fingerprint, result });
		else checkResults.delete(command);
		return result;
	}

	const CHECK_STATE_TEXT: Record<CheckState, string> = {
		pass: "pass",
		unchanged: "FAIL (was already failing before this task, in the same way)",
		changed: "FAIL (regression: already failing before this task, but the failure changed)",
		regression: "FAIL (regression)",
	};

	/**
	 * Output is shown for regressions only. A failure unchanged since the task started is not the worker's doing:
	 * a short excerpt on the task's first delegation says what it is, later delegations only name it.
	 */
	function formatChecks(checks: CheckResult[], classify: (check: CheckResult) => CheckState, rounds: number, verification: VerificationResult, notes: string[], firstDelegation: boolean): string {
		const lines = checks.map((check) => `- ${check.command}: ${CHECK_STATE_TEXT[classify(check)]}${check.safetyViolations.length ? ` — GIT SAFETY VIOLATION: ${check.safetyViolations.join("; ")}` : ""}`);
		const failing = checks
			.filter((check) => !check.ok && (firstDelegation || classify(check) !== "unchanged"))
			.map((check) => `$ ${check.command}\n${check.timedOut ? "timed out" : `exit code ${check.exitCode}`}\n${truncateUtf8Tail(check.output, classify(check) === "unchanged" ? 800 : 4000)}`);
		return [
			`AUTOMATIC VERIFICATION: ${verification.toUpperCase()}${rounds ? ` (${rounds} correction round${rounds > 1 ? "s" : ""})` : ""}`,
			...lines,
			...notes,
			...(failing.length ? ["", ...failing] : []),
		].join("\n");
	}

	/** Let the implementer fix its own regressions: resume its Claude session, or re-run with the diff and failures. */
	async function runCorrection(ctx: ExtensionContext, implementer: WorkerCandidate, sessionId: string | undefined, spec: ImplementationSpec, failing: CheckResult[], round: number, signal: AbortSignal | undefined): Promise<ImplementationOutcome> {
		const failures = failing.map(check => '$ ' + check.command + '\n' + truncateUtf8Tail(check.output, 6000)).join('\n\n');
		const instructions = '[CORRECTION ROUND ' + round + '] Checks now failing:\n' + failures + '\nFix the cause only inside the allowlist. Never weaken, skip or delete tests. Preserve correct work. If the requirements are ambiguous, stop and explain.';
		const chain = [implementer, ...config.workerChains[spec.profileName].filter(item => item.worker !== implementer.worker || item.model !== implementer.model)];
		const diff = spec.checkpoint ? (await changesSince(ctx.cwd, spec.allowedPaths, spec.checkpoint, config.maxDiffBytes)).diff : await scopedDiff(ctx.cwd, spec.allowedPaths, config.maxDiffBytes);
		return executeImplementation(ctx, { ...spec, candidates: chain, guide: spec.guide + '\n\n' + instructions, resumeSessionId: sessionId, resumeWorker: implementer.worker as SessionWorker, resumeModel: implementer.model, role: 'correct', resumePrompt: instructions, handoff: '[CURRENT WORK]\n' + diff + '\n\n' + instructions }, signal);
	}

	/** What learning knows about this repository, for the supervisor at planning time. */
	async function learningBriefing(ctx: ExtensionContext, profile: ExecutionProfileName): Promise<string[]> {
		if (!config.learning.enabled) return [];
		const repo = await repoKey(ctx.cwd);
		const lines: string[] = [];
		const hint = profileHint(profileStats(learning, repo), profile);
		if (hint) lines.push(`Learning: ${hint}`);
		const adjusted = config.workerChains[profile]
			.filter((item) => item.effort)
			.map((item) => ({ item, effort: config.learning.autoTuneEffort ? effectiveEffort(learning, profile, item.model, item.effort as Effort, repo, taskPacket?.assessment?.kind) : item.effort }))
			.filter(({ item, effort }) => effort !== item.effort)
			.map(({ item, effort }) => `${item.model} ${item.effort}→${effort}`);
		if (adjusted.length) lines.push(`Learning: calibrated worker effort for ${profile}: ${adjusted.join(", ")}.`);
		const lessons = lessonsFor(learning, repo);
		if (lessons.length) lines.push(`Known lessons for this repository (already given to workers; take them into account in the guide):\n${lessons.map((item) => `- ${item.text}`).join("\n")}`);
		return lines;
	}

	async function learningReport(ctx: ExtensionContext): Promise<string> {
		const repo = await repoKey(ctx.cwd);
		const stats = profileStats(learning, repo);
		const statLines = stats.map((item) => `  ${item.profile}: ${item.samples} scored delegations, first-pass ${Math.round(item.firstPassRate * 100)}%, mean quality ${item.meanQuality.toFixed(2)}, avg ${item.avgCorrectionRounds.toFixed(1)} correction rounds`);
		const adjustments = Object.entries(learning.effortAdjustments).map(([key, item]) => `  ${key.replace("|", " / ")}: ${item.configured} → ${item.effort} (${item.reason})`);
		const lessons = lessonsFor(learning, repo).map((item) => `  [${item.id}] ${item.text}${item.uses ? ` (reinforced ${item.uses}×)` : ""}`);
		return [
			`Learning ${config.learning.enabled ? "on" : "off"} · effort auto-tuning ${config.learning.autoTuneEffort ? "on" : "off"} · ${learning.outcomes.length} outcomes recorded in total`,
			`Repository: ${repo}`,
			"Quality by profile (this repository):",
			...(statLines.length ? statLines : ["  (no delegations recorded yet)"]),
			"Calibrated efforts (all repositories):",
			...(adjustments.length ? adjustments : ["  (none: config.json values are in use)"]),
			"Lessons for this repository:",
			...(lessons.length ? lessons : ["  (none)"]),
			"Remove a lesson: /SupervisedCoding learning forget <id> · clear everything: /SupervisedCoding learning reset",
			`Data: ${learningPath}`,
		].join("\n");
	}

	/**
	 * Consumption and quality of this conversation, for the user only (ctx.ui.notify never reaches the model,
	 * so these statistics cost no tokens).
	 */
	function usageReport(ctx: ExtensionContext): string[] {
		const tokens = (item: { input: number; output: number; cacheRead: number; cacheWrite: number }) => item.input + item.output + item.cacheRead + item.cacheWrite;
		const money = (value: number, estimated = false) => `${estimated ? "~" : ""}$${value.toFixed(value < 0.1 ? 3 : 2)}`;
		const fmt = (value: number) => value.toLocaleString("en-US");

		// Supervisor: straight from the session's assistant messages, per provider/model.
		const supervisors = new Map<string, { turns: number; input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number }>();
		for (const entry of ctx.sessionManager.getBranch() as Array<Record<string, any>>) {
			const message = entry.type === "message" ? entry.message : undefined;
			if (message?.role !== "assistant" || !message.usage) continue;
			const key = `${message.provider}/${message.model}`;
			const item = supervisors.get(key) ?? { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
			item.turns++;
			item.input += numberField(message.usage.input);
			item.output += numberField(message.usage.output);
			item.cacheRead += numberField(message.usage.cacheRead);
			item.cacheWrite += numberField(message.usage.cacheWrite);
			item.costUsd += numberField(message.usage.cost?.total);
			supervisors.set(key, item);
		}

		// Workers and reviewers: Claude Code and Pi both report the cost of each run (API-equivalent for subscriptions).
		const estimate = (item: ModelUsage): { cost: number; estimated: boolean } => ({ cost: item.costUsd, estimated: false });
		const workerRows = Object.values(metrics.byModel).sort((a, b) => tokens(b) - tokens(a));
		const supervisorTotal = [...supervisors.values()].reduce((sum, item) => sum + tokens(item), 0);
		const supervisorCost = [...supervisors.values()].reduce((sum, item) => sum + item.costUsd, 0);
		const workerTotal = workerRows.reduce((sum, item) => sum + tokens(item), 0);
		const workerCost = workerRows.reduce((sum, item) => sum + estimate(item).cost, 0);
		const grand = supervisorTotal + workerTotal;
		const pct = (value: number) => (grand > 0 ? `${Math.round((value / grand) * 100)}%` : "0%");
		const row = (label: string, count: string, item: { input: number; output: number; cacheRead: number; cacheWrite: number }, cost: string) =>
			`  ${label.padEnd(42)} ${count.padEnd(9)} ${fmt(tokens(item)).padStart(11)} tok (${pct(tokens(item)).padStart(4)})  in ${fmt(item.input)} · out ${fmt(item.output)} · cache ${fmt(item.cacheRead + item.cacheWrite)}  ${cost}`;

		const lines: string[] = ["Consumption in this conversation:"];
		lines.push(" Supervisor");
		if (!supervisors.size) lines.push("  (no supervisor turns yet)");
		for (const [key, item] of supervisors) lines.push(row(key, `${item.turns} turns`, item, money(item.costUsd)));
		lines.push(" Workers and reviewers");
		if (!workerRows.length) lines.push("  (no worker runs yet)");
		for (const item of workerRows) {
			const label = item.worker === "claude" ? `Claude ${item.model}` : item.worker === "api" ? `API ${item.provider}/${item.model}` : `Pi ${item.provider}/${item.model}`;
			const { cost, estimated } = estimate(item);
			lines.push(row(label, `${item.runs} run${item.runs === 1 ? "" : "s"}`, item, money(cost, estimated)));
		}
		lines.push(`  Total: ${fmt(grand)} tokens · ${money(supervisorCost + workerCost)} API-equivalent (supervisor ${pct(supervisorTotal)}, workers/reviewers ${pct(workerTotal)})`);

		// What is really paid: pay-per-use API keys cost money per token; subscriptions consume plan limits instead.
		const supervisorBilling = (key: string): Billing => {
			const [provider, ...rest] = key.split("/");
			const model = ctx.modelRegistry.find(provider, rest.join("/"));
			return model ? (ctx.modelRegistry.isUsingOAuth(model) ? "subscription" : "api") : "unknown";
		};
		let paid = 0;
		const paidModels: string[] = [];
		const planModels: string[] = [];
		for (const [key, item] of supervisors) {
			const billing = supervisorBilling(key);
			if (billing === "subscription") planModels.push(key);
			else {
				paid += item.costUsd;
				paidModels.push(`${key} ${money(item.costUsd)}`);
			}
		}
		for (const item of workerRows) {
			const label = item.worker === "claude" ? `Claude ${item.model}` : item.worker === "api" ? `API ${item.provider}/${item.model}` : `Pi ${item.provider}/${item.model}`;
			const { cost, estimated } = estimate(item);
			if (item.billing === "subscription") planModels.push(label);
			else {
				paid += cost;
				paidModels.push(`${label} ${money(cost, estimated)}${item.billing === "unknown" || !item.billing ? " (billing unknown)" : ""}`);
			}
		}
		lines.push(`Reported/estimated API-equivalent spend outside known subscriptions (not a billing statement): ${money(paid)}${paidModels.length ? ` (${paidModels.join(", ")})` : ""}`);
		if (planModels.length) lines.push(`On subscriptions (no per-token charge, they use plan limits): ${planModels.join(", ")}`);

		const roleNames: Record<string, string> = { implement: "implementation", correct: "self-correction", review: "independent review", consult: "consultation", probe: "credit probes" };
		const roles = [`supervisor ${pct(supervisorTotal)}`, ...Object.entries(metrics.byRole).sort((a, b) => b[1].tokens - a[1].tokens).map(([role, item]) => `${roleNames[role] ?? role} ${pct(item.tokens)}`)];
		lines.push(`By role: ${roles.join(" · ")}`);

		const allInput = [...supervisors.values(), ...workerRows].reduce((sum, item) => sum + item.input + item.cacheRead + item.cacheWrite, 0);
		const cached = [...supervisors.values(), ...workerRows].reduce((sum, item) => sum + item.cacheRead, 0);
		if (allInput > 0) lines.push(`Prompt cache: ${Math.round((cached / allInput) * 100)}% of input tokens read from cache`);

		const deltas: string[] = [];
		for (const [key, start] of Object.entries(metrics.limitStart)) {
			const [healthKey, window] = key.split("|");
			const now = health[healthKey]?.windows?.[window]?.utilization;
			if (now === undefined) continue;
			const name = healthKey === "claude-cli" ? "Claude" : healthKey.startsWith("pi:") ? healthKey.slice(3) : healthKey;
			deltas.push(`${name} ${window.replace(/_/g, " ")} ${Math.round(start * 100)}% → ${Math.round(now * 100)}% (+${Math.max(0, Math.round((now - start) * 100))})`);
		}
		lines.push(`Observed account quota movement (may include other clients; not attributable billing): ${deltas.length ? deltas.join(" · ") : "no readings yet (/SupervisedCoding credits refresh)"}`);
		if (unknownUsageRuns) lines.push(`Usage unavailable for ${unknownUsageRuns} invocation(s); totals are incomplete, not zero-cost.`);

		const verdicts = Object.entries(metrics.reviewVerdicts).map(([verdict, count]) => `${verdict.toUpperCase()} ${count}`).join(", ");
		const completed = metrics.delegations - metrics.failedDelegations;
		lines.push(`Quality: ${metrics.delegations} delegations (${completed} completed, ${metrics.failedDelegations} failed) · ${metrics.autoVerifiedDelegations} auto-verified, ${metrics.firstPassDelegations} green at the first attempt, ${metrics.correctionRounds} correction rounds · reviews: ${verdicts || "none"}`);
		lines.push(`Routing: failovers workers ${metrics.providerFailovers}, supervisor ${metrics.supervisorFailovers} · flagship asked ${metrics.flagshipRequests} (${metrics.flagshipApprovals} approved) · consultations ${metrics.readOnlyConsultations} · resumed sessions ${metrics.resumedDelegations} · checks run ${metrics.verifications}, reused ${metrics.reusedChecks}`);
		if (completed > 0) lines.push(`Average per completed delegation: ${fmt(Math.round(grand / completed))} tokens · ${money((supervisorCost + workerCost) / completed)}`);
		lines.push("Per-model costs are API-equivalent; for subscriptions the real cost is the plan usage above. ~ = estimated from Pi's price list.");
		return lines;
	}

	/** Every candidate with a configured effort (Claude --effort, Pi --thinking) is a calibration target. */
	function tuningTargets(repo?: string, kind?: string): Array<{ profile: string; model: string; configured: Effort; repo?: string; kind?: string }> {
		return PROFILE_NAMES.flatMap((profile) => config.workerChains[profile]
			.filter((item) => item.effort)
			.map((item) => ({ profile, model: item.model, configured: item.effort as Effort, repo, kind })));
	}

	/**
	 * Record the outcome of a delegation and recalibrate effort. Delegations that never reached a worker for
	 * provider reasons carry no quality signal and are not recorded.
	 */
	async function learnFromDelegation(ctx: ExtensionContext, data: { implementer: WorkerCandidate; final: RunResult; profileName: ExecutionProfileName; verification: VerificationResult; correctionRounds: number; reviewVerdict: ReviewVerdict; failed: boolean; providerFailure?: boolean; budgetStop?: boolean; combined?: Usage }): Promise<string[]> {
		if (!config.learning.enabled) return [];
		if (runFailed(data.final) && FAILOVER_KINDS.has(failureKindOf(data.final))) return [];
		const repo = await repoKey(ctx.cwd);
		let changes: string[] = [];
		await mutateLearning(ctx, state => {
		recordOutcome(state, {
			evidenceVersion: 2,
			taskKind: taskPacket?.assessment?.kind ?? "general",
			accepted: false,
			failureDomain: data.providerFailure ? "provider" : data.budgetStop ? "budget" : "quality",
			at: Date.now(),
			repo,
			taskId: taskPacket?.id ?? "",
			profile: data.profileName,
			worker: data.implementer.worker,
			model: data.implementer.model,
			effort: data.implementer.effort,
			verification: data.verification,
			correctionRounds: data.correctionRounds,
			review: data.reviewVerdict,
			failed: data.failed,
			tokens: data.combined?.totalTokens ?? 0,
			costUsd: data.combined?.cost.total ?? 0,
		});
		changes = config.learning.autoTuneEffort ? tuneEfforts(state, tuningTargets(repo, taskPacket?.assessment?.kind)) : [];
		});
		if (changes.length) ctx.ui.notify(`${EXTENSION_NAME} learned: ${changes.join("; ")}`, "info");
		return changes;
	}

	/**
	 * Run the profile's worker chain: best healthy candidate first, retry transient failures, move to the next
	 * candidate on credit/auth/availability failures with a handoff note, and stop on genuine task failures.
	 */
	async function executeImplementation(ctx: ExtensionContext, spec: ImplementationSpec, signal: AbortSignal | undefined, onProgress?: (text: string, label: string) => void): Promise<ImplementationOutcome> {
		const repo = await repoKey(ctx.cwd);
		learning = loadLearning(learningPath);
		const configuredChain = spec.candidates ?? config.workerChains[spec.profileName];
		const routed = config.learning.enabled && config.learning.autoRouteModels && !spec.candidates
			? routeWithEvidence(configuredChain, learning.outcomes, repo, spec.profileName, spec.assessment?.kind ?? "general", config.learning.minModelSamples)
			: { candidates: configuredChain, reason: "configured quality order" };
		const chain = orderChain(routed.candidates, spec.preferWorker);
		const { usable, blocked } = rankCandidates(chain, workerHealthKeys, health, config.creditHeadroom);
		if (!usable.length) throw new Error(`No worker available for profile ${spec.profileName}: all candidates are out of credits or unavailable (${describeBlocked(blocked)}). Use /SupervisedCoding credits refresh after a reset, or /SupervisedCoding credits reset to retry anyway.`);
		const before = await getGitSnapshot(ctx.cwd);
		const attempts: AttemptRecord[] = blocked.map((item) => ({ label: candidateLabel(item.candidate), ok: false, kind: "credits" as FailureKind, detail: `skipped: exhausted until ${formatUntil(item.until)}`, order: item.index }));
		const usage: Array<Usage | undefined> = [];
		let final: RunResult | undefined;
		let finalCandidate: WorkerCandidate | undefined;
		let handoff = spec.handoff ?? "";
		let resumed = false;
		let resumeAvailable = Boolean(spec.resumeSessionId);
		let providerFailureSeen = false;
		let limitReached: string | undefined;
		for (const { candidate: configured, index: order } of usable) {
			const currentAvailability = availability(health, workerHealthKeys(configured), config.creditHeadroom);
			if (currentAvailability.state === "blocked") { attempts.push({ label: candidateLabel(configured), ok: false, detail: "skipped: account became unavailable during this chain", order }); continue; }
			// Effort: the supervisor's explicit override, else what learning calibrated for this profile/model, else config.json.
			const baseEffort = taskEffort(spec.profileName, spec.assessment, configured.effort);
			const learnedEffort = config.learning.enabled && config.learning.autoTuneEffort && !spec.candidates ? effectiveEffort(learning, spec.profileName, configured.model, baseEffort, repo, spec.assessment?.kind) : baseEffort;
			const candidate: WorkerCandidate = { ...configured, maxTurns: config.workerMaxTurns[spec.profileName], effort: resolveEffort(spec.effort, learnedEffort, spec.profileName) };
			const label = candidateLabel(candidate);
			if (isFlagship(candidate.model) && !(await approveFlagship(ctx, candidate.model, modelDisplayName(ctx, candidate.provider ?? "anthropic", candidate.model)))) {
				attempts.push({ label, ok: false, detail: "declined: flagship not authorized", order });
				continue;
			}
			let resumeId = resumeAvailable && candidate.worker === (spec.resumeWorker ?? "claude") && (!spec.resumeModel || spec.resumeModel === candidate.model) ? spec.resumeSessionId : undefined;
			let basePrompt = buildWorkerPrompt(spec.task, spec.guide, spec.criteria, spec.allowedPaths, Boolean(resumeId), spec.repoContext);
			if (resumeId && spec.resumePrompt) {
				basePrompt = spec.resumePrompt;
				handoff = "";
			}
			let result: RunResult | undefined;
			let kind: FailureKind | undefined;
			let stoppedBy: string | undefined;
			for (let attempt = 0; attempt <= config.transientRetryAttempts; attempt++) {
				// The cumulative delegation budget is checked before every paid attempt, never during one.
				stoppedBy = budgetExceeded();
				if (stoppedBy) break;
				if (activeBudget && config.delegationBudgetUsd > 0) candidate.maxBudgetUsd = Math.max(0.001, config.delegationBudgetUsd - activeBudget.spent);
				const fullPrompt = `${handoff ? `${handoff}\n\n` : ""}${basePrompt}`;
				// A Pi worker without bash cannot run commands: it must not claim checks passed.
				const workerNotes = `\n\n[WORKER NOTES]\nEdit only the allowlisted paths and preserve pre-existing changes. Never stage, commit, push, merge, change branches, or rewrite Git history. If shell tools are unavailable, do not claim checks passed: the extension runs the VERIFY commands after you finish; list any other verification the supervisor should run.`;
				if (candidate.worker === "claude") {
					result = await runClaude(ctx.cwd, config, candidate, "edit", fullPrompt, resumeId, signal, minutes(config.workerTimeoutMinutes), (text) => onProgress?.(text, label));
				} else {
					result = await runPiWorker(ctx, candidate, "edit", `${fullPrompt}${config.piWorkerTools.includes("bash") ? "" : workerNotes}`, resumeId, signal, minutes(config.workerTimeoutMinutes), (text) => onProgress?.(text, label));
				}
				recordRun(result, spec.role ?? "implement");
				usage.push(result.usage);
				if (signal?.aborted) throw new Error("Operation aborted; partial work was preserved.");
				stoppedBy = executionLimit(result);
				if (stoppedBy) break;
				kind = runFailed(result) ? failureKindOf(result) : undefined;
				if (kind !== "transient" || attempt >= config.transientRetryAttempts) break;
				if (result.sessionId) {
					resumeId = result.sessionId;
					basePrompt = `[RETRY AFTER TRANSIENT PROVIDER FAILURE]\nContinue the authorized task from the current session. Preserve completed changes, inspect current status, and finish the remaining work.\nPATH ALLOWLIST\n${spec.allowedPaths.join("\n")}`;
					handoff = "";
				} else {
					const diff = spec.checkpoint ? (await changesSince(ctx.cwd, spec.allowedPaths, spec.checkpoint, config.maxDiffBytes)).diff : await scopedDiff(ctx.cwd, spec.allowedPaths, config.maxDiffBytes);
					handoff = `[RETRY] The previous attempt may have edited files. Continue from these changes; do not repeat completed work.\n${diff}`;
				}
				await waitForRetry(config.transientRetryDelayMs * 2 ** attempt, signal);
			}
			if (!result) {
				// The budget ran out before this candidate could start: stop the chain, keep whatever came before.
				if (stoppedBy) {
					limitReached = stoppedBy;
					break;
				}
				continue;
			}
			if (resumeId) {
				resumed = true;
				resumeAvailable = false;
			}
			recordWorkerHealth(candidate, result, kind);
			final = result;
			finalCandidate = candidate;
			if (stoppedBy) {
				// An execution limit is neither a provider failure nor a verdict on the code: no failover, session kept.
				limitReached = stoppedBy;
				attempts.push({ label, ok: false, detail: `stopped: ${stoppedBy}`, order });
				break;
			}
			attempts.push({ label, ok: !kind, kind, detail: kind ? (result.errorMessage || result.stderr).trim().slice(0, 300) : undefined, order });
			if (!kind) break;
			// Coding/test/context failures must be diagnosed by the supervisor, never hidden by switching models.
			if (!FAILOVER_KINDS.has(kind) && kind !== "transient") break;
			providerFailureSeen = true;
			metrics.providerFailovers++;
			const now = await getGitSnapshot(ctx.cwd);
			const partial = filesChangedBetween(before, now).filter((file) => pathInAllowedScope(file, spec.allowedPaths));
			handoff = handoffNote(label, kind, partial, partial.length ? spec.checkpoint ? (await changesSince(ctx.cwd, spec.allowedPaths, spec.checkpoint, config.maxDiffBytes)).diff : await scopedDiff(ctx.cwd, partial, config.maxDiffBytes) : "");
		}
		if (!final || !finalCandidate) {
			if (limitReached) throw new Error(`Delegation stopped before a worker could start: ${limitReached}.`);
			throw new Error(`No worker could be started for profile ${spec.profileName}: ${attempts.map((item) => `${item.label} (${item.detail ?? item.kind})`).join("; ") || "empty chain"}.`);
		}
		const failed = runFailed(final) || Boolean(limitReached);
		const after = await getGitSnapshot(ctx.cwd);
		const scopeViolations = compareGitSnapshots(before, after, spec.allowedPaths);
		const chainLine = attempts.length > 1 ? `Worker chain: ${inChainOrder(attempts).map((item) => `${item.label} ${item.ok ? "✓" : `✗ ${item.kind ?? ""}${item.detail?.startsWith("skipped") ? " (skipped)" : item.detail?.startsWith("declined") ? "declined by user" : ""}`}`).join(" → ")}\n\n` : "";
		let primaryOutput = `Routing: ${routed.reason}.\n${chainLine}${final.output || final.errorMessage || final.stderr || "The worker returned no output."}`;
		if (limitReached) primaryOutput += `\n\nSTOPPED AT ${limitReached.toUpperCase()}: partial work and the worker session are preserved. Review what was done, then delegate the rest with continuePrevious=true so the same session finishes without re-exploring.`;
		if (scopeViolations.length) primaryOutput += `\n\nSCOPE/GIT SAFETY VIOLATION: ${scopeViolations.join("; ")}. Review and correct manually; no automatic revert was attempted.`;
		return { failed: failed || scopeViolations.length > 0, final, finalCandidate, primaryOutput, attempts: inChainOrder(attempts), usage, before, after, scopeViolations, resumed, limitReached };
	}

	/** Read-only consultation with failover across reviewers; any working-tree mutation is reported as a violation. */
	async function runConsultation(ctx: ExtensionContext, order: WorkerCandidate[], header: string, question: string, paths: string[], signal: AbortSignal | undefined, options: { diff?: string; diffComplete?: boolean; diffLabel?: string; requireVerdict?: boolean; role?: UsageRole; maxTurns?: number } = {}): Promise<ConsultOutcome> {
		const { usable, blocked } = rankCandidates(order, workerHealthKeys, health, config.creditHeadroom);
		const attempts: AttemptRecord[] = blocked.map((item) => ({ label: candidateLabel(item.candidate), ok: false, kind: "credits" as FailureKind, detail: "skipped: exhausted", order: item.index }));
		const usage: Array<Usage | undefined> = [];
		const before = await getGitSnapshot(ctx.cwd);
		let text = usable.length ? "" : `No read-only reviewer available (${describeBlocked(blocked)}).`;
		let reviewer: string | undefined;
		let failed = true;
		const pathList = paths.map((item) => `- ${item}`).join("\n");
		const diffBlock = options.diff ? `\n\nCHANGES UNDER REVIEW (${options.diffLabel ?? "made by this delegation"})\n\`\`\`diff\n${options.diff}\n\`\`\`\nBase the review on these changes; read files only for the surrounding context you need.` : "";
		const verdictLine = options.requireVerdict ? "\nEnd with exactly one final line: VERDICT: PASS (no material defect) | MINOR (only minor issues) | MAJOR (bugs, missed requirements, regressions or unsafe behavior)." : "";
		let material: string | undefined | null = null;
		for (const { candidate: configured, index: order } of usable) {
			if (isFlagship(configured.model) || availability(health, workerHealthKeys(configured), config.creditHeadroom).state === "blocked") continue;
			const candidate: WorkerCandidate = options.maxTurns ? { ...configured, maxTurns: options.maxTurns } : configured;
			const label = candidateLabel(candidate);
			const prompt = `${header}\n${question}\nRelevant paths:\n${pathList}${diffBlock}\n\nInspect only the listed paths and directly relevant symbols. Do not edit, write, stage, commit, push, merge, switch branches, or run mutating commands. Return concise findings ordered by severity, concrete evidence with file/symbol references, recommended action, verification ideas, and remaining uncertainty. Do not summarize unrelated code.${verdictLine}`;
			if (candidate.worker === "api") {
				if (options.diffComplete === false || options.diff?.includes("[Diff truncated")) { attempts.push({ label, ok: false, detail: "skipped: incomplete review material requires browsing", order }); continue; }
				// An API reviewer cannot browse: it needs the files inline, and only when they fit.
				if (material === null) material = collectFiles(ctx.cwd, paths, 250_000);
				if (material === undefined) {
					attempts.push({ label, ok: false, detail: "skipped: files too large for an API review", order });
					continue;
				}
			}
			let result: RunResult | undefined;
			let kind: FailureKind | undefined;
			for (let attempt = 0; attempt <= config.transientRetryAttempts; attempt++) {
				result = candidate.worker === "claude"
					? await runClaude(ctx.cwd, config, candidate, "readonly", prompt, undefined, signal, minutes(config.consultTimeoutMinutes))
					: candidate.worker === "api"
						? await runApiReview(ctx, candidate, config.reviewApi?.reasoning ?? "high", prompt, material ?? "", signal, minutes(config.consultTimeoutMinutes), config.reviewMaxTokens)
						: await runPiWorker(ctx, candidate, "readonly", prompt, undefined, signal, minutes(config.consultTimeoutMinutes));
				recordRun(result, options.role ?? "consult");
				usage.push(result.usage);
				if (signal?.aborted) throw new Error("Review aborted.");
				kind = runFailed(result) ? failureKindOf(result) : undefined;
				if (kind !== "transient" || attempt >= config.transientRetryAttempts) break;
				await waitForRetry(config.transientRetryDelayMs * 2 ** attempt, signal);
			}
			if (!result) continue;
			recordWorkerHealth(candidate, result, kind);
			attempts.push({ label, ok: !kind, kind, detail: kind ? (result.errorMessage || result.stderr).trim().slice(0, 300) : undefined, order });
			text = result.output || result.errorMessage || result.stderr || "The reviewer returned no output.";
			reviewer = label;
			failed = Boolean(kind) || Boolean(result.incomplete) || !result.output.trim() || Boolean(options.requireVerdict && parseVerdict(result.output) === "none");
			if (!failed) break;
			// Unlike an implementation, a failed review hides nothing by moving on: without the next reviewer there
			// would be no review at all. Only provider failures count as failovers.
			if (kind && (FAILOVER_KINDS.has(kind) || kind === "transient")) metrics.providerFailovers++;
			text += `\nReviewer ${label} did not produce a complete ${options.requireVerdict ? "verdict" : "answer"}; trying the next reviewer.`;
		}
		const after = await getGitSnapshot(ctx.cwd);
		const violations = compareGitSnapshots(before, after, []);
		return { failed: failed || violations.length > 0, text, reviewer, attempts: inChainOrder(attempts), usage, violations, gitAvailable: before.available && after.available, verdict: failed ? "none" : parseVerdict(text) };
	}

	/**
	 * Every non-flagship model of the given profiles' chains (strongest profile first), one entry per worker and
	 * model, whatever its family: any model can review. The API reviewer comes first (no CLI overhead; it is used
	 * only when the review material is complete). Flagships are for implementation only.
	 */
	function reviewPool(profiles: ExecutionProfileName[]): WorkerCandidate[] {
		const seen = new Set<string>();
		const result: WorkerCandidate[] = config.reviewApi ? [{ worker: "api", provider: config.reviewApi.provider, model: config.reviewApi.model }] : [];
		for (const profile of profiles) {
			for (const item of config.workerChains[profile]) {
				const key = `${item.worker}:${item.provider ?? ""}:${item.model}`;
				if (isFlagship(item.model) || seen.has(key)) continue;
				seen.add(key);
				result.push(item);
			}
		}
		return result;
	}

	/**
	 * Independent review: models of another family first (they catch different mistakes), then other models of the
	 * implementer's family, and the implementer's own model only as a last resort. Within each group the configured
	 * order holds. Families are derived from the model, never assigned to a role.
	 */
	function reviewOrder(implementer: WorkerCandidate, profile: ExecutionProfileName): WorkerCandidate[] {
		const family = modelFamily(implementer);
		const rank = (item: WorkerCandidate) => (item.model === implementer.model ? 2 : modelFamily(item) === family ? 1 : 0);
		return [...reviewPool([profile, "large", "critical"])].sort((a, b) => rank(a) - rank(b));
	}

	function consultOrder(reviewer: ConsultReviewer, profileName: ExecutionProfileName): WorkerCandidate[] {
		const pool = reviewPool([profileName, "large"]);
		if (reviewer === "auto") return pool;
		const wanted = CONSULT_FAMILIES[reviewer];
		return [...pool].sort((a, b) => Number(modelFamily(b) === wanted) - Number(modelFamily(a) === wanted));
	}

	// ── Supervisor (Pi model) selection ────────────────────────────────────────────────────────────

	interface ResolvedSupervisor {
		candidate: SupervisorCandidate;
		model: Model<any>;
	}

	function resolveSupervisors(ctx: ExtensionContext): { resolved: ResolvedSupervisor[]; skipped: string[] } {
		const resolved: ResolvedSupervisor[] = [];
		const skipped: string[] = [];
		const all = [...config.supervisorChain, ...Object.values(config.supervisorProfiles).flat()];
		const seen = new Set<string>();
		for (const candidate of all) {
			const key = `${candidate.provider}/${candidate.model}`;
			if (seen.has(key)) continue;
			seen.add(key);
			const model = ctx.modelRegistry.find(candidate.provider, candidate.model);
			if (!model) skipped.push(`${candidate.provider}/${candidate.model}: unknown model`);
			else if (!ctx.modelRegistry.hasConfiguredAuth(model)) skipped.push(`${candidate.provider}/${candidate.model}: no Pi auth`);
			else if (!(config.allowedSupervisorProviders.includes("*") || config.allowedSupervisorProviders.includes(candidate.provider))) skipped.push(`${candidate.provider}/${candidate.model}: provider not allowed`);
			else resolved.push({ candidate, model });
		}
		return { resolved, skipped };
	}

	/** A flagship supervisor is eligible only while the user's approval for the current open task lasts. */
	function flagshipGranted(candidate: SupervisorCandidate): boolean {
		const grant = supervisorFlagshipGrant;
		return Boolean(grant && drivesThisPrompt(openTask()) && openTask()?.profile === "critical" && openTask()?.id === grant.taskId && grant.provider === candidate.provider && grant.model === candidate.model);
	}

	function bestSupervisor(ctx: ExtensionContext): { best?: ResolvedSupervisor; ranked: RankedCandidate<ResolvedSupervisor>[]; blocked: RankedCandidate<ResolvedSupervisor>[] } {
		const eligible = resolveSupervisors(ctx).resolved.filter((item) => !isFlagship(item.candidate.model) || flagshipGranted(item.candidate));
		const current = openTask();
		const preferences = drivesThisPrompt(current) ? config.supervisorProfiles[current!.profile] ?? [] : [];
		const priority = (item: ResolvedSupervisor) => { const index = preferences.findIndex(p => p.provider === item.candidate.provider && p.model === item.candidate.model); return index < 0 ? preferences.length : index; };
		eligible.sort((a, b) => priority(a) - priority(b));
		// An approved flagship is the user's explicit choice for this task, so it goes ahead of the normal order.
		eligible.sort((a, b) => Number(flagshipGranted(b.candidate)) - Number(flagshipGranted(a.candidate)));
		const { usable, blocked } = rankCandidates(eligible, (item) => supervisorHealthKeys(item.candidate), health, config.creditHeadroom);
		return { best: usable[0]?.candidate, ranked: usable, blocked };
	}

	function isCurrent(ctx: ExtensionContext, item: ResolvedSupervisor): boolean {
		return ctx.model?.provider === item.candidate.provider && ctx.model?.id === item.candidate.model;
	}

	async function switchSupervisor(ctx: ExtensionContext, target: ResolvedSupervisor, reason: string): Promise<boolean> {
		const previous = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
		settingModel = true;
		try {
			const ok = await pi.setModel(target.model);
			if (!ok) {
				markExhausted(health, `pi:model:${target.candidate.provider}/${target.candidate.model}`, "Pi could not select this model (auth missing)", Date.now() + cooldownMs(), "setModel");
				return false;
			}
			applySupervisorEffort();
		} catch (error) {
			markExhausted(health, `pi:model:${target.candidate.provider}/${target.candidate.model}`, error instanceof Error ? error.message : String(error), Date.now() + cooldownMs(), "setModel");
			return false;
		} finally {
			settingModel = false;
		}
		ctx.ui.notify(`Supervisor model: ${previous} → ${target.candidate.provider}/${target.candidate.model} (${reason})`, "info");
		return true;
	}

	/** The strongest flagship supervisor that currently has credits, if any. */
	function availableFlagshipSupervisor(ctx: ExtensionContext): ResolvedSupervisor | undefined {
		const flagships = resolveSupervisors(ctx).resolved.filter((item) => isFlagship(item.candidate.model));
		return rankCandidates(flagships, (item) => supervisorHealthKeys(item.candidate), health, config.creditHeadroom).usable[0]?.candidate;
	}

	/** Pick the best available supervisor regardless of the model the session started with. */
	async function ensureBestSupervisor(ctx: ExtensionContext, reason: string): Promise<void> {
		if (supervisorMode !== "auto" || !config.supervisorChain.length) return;
		let { best, ranked } = bestSupervisor(ctx);
		while (best && !isCurrent(ctx, best)) {
			if (await switchSupervisor(ctx, best, reason)) return;
			ranked = ranked.filter((item) => item.candidate !== best);
			best = ranked[0]?.candidate;
		}
	}

	function recordSupervisorFailure(provider: string, model: string, errorMessage: string, kind: FailureKind): void {
		const now = Date.now();
		const until = parseResetHint(errorMessage, now) ?? health[`pi:${provider}`]?.resetsAt;
		if (kind === "unavailable") markExhausted(health, `pi:model:${provider}/${model}`, errorMessage, now + minutes(config.unavailableCooldownMinutes), "supervisor error", now);
		else markExhausted(health, `pi:${provider}`, errorMessage, until && until > now ? until : now + cooldownMs(), "supervisor error", now);
	}

	async function probeSupervisor(ctx: ExtensionContext, item: ResolvedSupervisor): Promise<string> {
		const label = `${item.candidate.provider}/${item.candidate.model}`;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 60_000);
		let headers: Record<string, string> | undefined;
		try {
			const message = await ctx.modelRegistry.complete(item.model, { messages: [{ role: "user", content: "Reply with exactly: OK", timestamp: Date.now() }] }, {
				signal: controller.signal,
				maxTokens: config.probeMaxTokens,
				onResponse: (response: { headers: Record<string, string> }) => { headers = response.headers; },
			} as any);
			recordRun({ worker: "api", provider: item.candidate.provider, model: item.candidate.model, exitCode: message.stopReason === "error" || message.stopReason === "aborted" ? 1 : 0, output: "", stderr: "", errorMessage: message.errorMessage, turns: 1, costUsd: message.usage?.cost?.total ?? 0, usage: message.usage, billing: ctx.modelRegistry.isUsingOAuth(item.model) ? "subscription" : "api", timedOut: controller.signal.aborted, signal: { text: message.errorMessage ?? "" } }, "probe");
			if (headers) {
				const reading = readLimitHeaders(headers);
				if (reading) {
					lastLimitHeaders[item.candidate.provider] = reading.raw;
					applyReading(health, `pi:${item.candidate.provider}`, reading, "probe", cooldownMs());
				}
			}
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				const kind = classifyFailure(message.errorMessage ?? "");
				if (FAILOVER_KINDS.has(kind)) recordSupervisorFailure(item.candidate.provider, item.candidate.model, message.errorMessage ?? kind, kind);
				return `${label}: ${kind} — ${(message.errorMessage ?? "").slice(0, 160)}`;
			}
			markHealthy(health, `pi:model:${label}`, "probe");
			if (!headers || !readLimitHeaders(headers)) markHealthy(health, `pi:${item.candidate.provider}`, "probe");
			const util = health[`pi:${item.candidate.provider}`]?.utilization;
			return `${label}: ok${util !== undefined ? ` (${Math.round(util * 100)}% used)` : ""}`;
		} catch (error) {
			return `${label}: probe failed — ${error instanceof Error ? error.message : String(error)}`;
		} finally {
			clearTimeout(timer);
		}
	}

	async function probeClaude(ctx: ExtensionContext): Promise<string> {
		const candidate: WorkerCandidate = { worker: "claude", model: config.claudeProbeModel, effort: "low" };
		try {
			const result = await runClaude(ctx.cwd, config, candidate, "probe", "Reply with exactly: OK", undefined, undefined, 120_000);
			recordRun(result, "probe");
			const kind = runFailed(result) ? failureKindOf(result) : undefined;
			recordWorkerHealth(candidate, result, kind);
			const item = health[claudeLimitKey(result.limitInfo, candidate.model)];
			const windows = item?.windows ? Object.entries(item.windows).map(([name, data]) => `${name} ${data.utilization !== undefined ? `${Math.round(data.utilization * 100)}%` : "?"}`).join(", ") : "";
			return kind ? `Claude Code: ${kind} — ${(result.errorMessage ?? result.stderr).slice(0, 160)}` : `Claude Code: ok${windows ? ` (${windows})` : ""}`;
		} catch (error) {
			return `Claude Code: probe failed — ${error instanceof Error ? error.message : String(error)}`;
		}
	}

	async function refreshCredits(ctx: ExtensionContext, force = false): Promise<string[]> {
		const fresh = (keys: string[]) => !force && keys.some(key => health[key] && (Date.now() - health[key].updatedAt < config.probeTtlMinutes * 60_000 || availability(health, [key], config.creditHeadroom).state === "blocked"));
		const lines: string[] = [];
		if (!fresh(["claude-cli", `claude-cli:model:${config.claudeProbeModel}`])) lines.push(await probeClaude(ctx));
		else lines.push("Claude Code: using recent credit reading.");
		// Model quotas can differ even within one provider; probe lazily when selected, not the whole chain.
		const best = bestSupervisor(ctx).best;
		if (best && !isFlagship(best.candidate.model)) {
			if (!fresh(supervisorHealthKeys(best.candidate))) lines.push(await probeSupervisor(ctx, best));
			else lines.push(`${best.candidate.model}: using recent credit reading.`);
		}
		persist();
		return lines;
	}

	function creditsReport(ctx: ExtensionContext): string {
		const now = Date.now();
		const rows = Object.entries(health).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => {
			const state = availability(health, [key], config.creditHeadroom, now).state;
			const util = item.utilization !== undefined ? ` ${Math.round(item.utilization * 100)}% used` : "";
			const until = state === "blocked" ? ` until ${formatUntil(item.blockedUntil, now)}` : item.resetsAt && item.resetsAt > now ? ` · resets ${formatUntil(item.resetsAt, now)}` : "";
			return `  ${state === "blocked" ? "✗" : state === "degraded" ? "!" : "✓"} ${key}: ${item.status}${util}${until}${state === "blocked" && item.reason ? ` — ${item.reason.slice(0, 120)}` : ""}`;
		});
		const { resolved, skipped } = resolveSupervisors(ctx);
		const supervisorRows = resolved.map((item, index) => {
			const state = availability(health, supervisorHealthKeys(item.candidate), config.creditHeadroom, now);
			return `  ${index + 1}. ${item.candidate.provider}/${item.candidate.model}${isCurrent(ctx, item) ? " ← current" : ""}: ${state.state}${state.until ? ` until ${formatUntil(state.until, now)}` : ""}`;
		});
		const headerRows = Object.entries(lastLimitHeaders).map(([provider, raw]) => `  ${provider}: ${Object.entries(raw).map(([k, v]) => `${k}=${v}`).join(", ").slice(0, 400)}`);
		return [
			`Credit/limit state (headroom ${Math.round(config.creditHeadroom * 100)}%):`,
			...(rows.length ? rows : ["  (no readings yet — run /SupervisedCoding credits refresh)"]),
			`Supervisor chain (${supervisorMode}):`,
			...(supervisorRows.length ? supervisorRows : ["  (no candidate with Pi auth)"]),
			...(skipped.length ? [`  skipped: ${skipped.join("; ")}`] : []),
			...(headerRows.length ? ["Last limit headers:", ...headerRows] : []),
		].join("\n");
	}

	// ── Supervisor external recovery (last resort when no supervisor model is left) ─────────────

	async function recoverFromSupervisorFailure(ctx: ExtensionContext, task: string): Promise<void> {
		supervisorRecoveryRunning = true;
		try {
			const maxAge = minutes(config.recoveryMaxAgeMinutes);
			if (!taskPacket || !["implementing", "failed", "reviewing"].includes(taskPacket.phase) || (maxAge > 0 && Date.now() - taskPacket.updatedAt > maxAge)) {
				throw new Error(`no recent unfinished TaskPacket (phase ${taskPacket?.phase ?? "none"}); nothing safe to continue without a supervisor.`);
			}
			const allowedPaths = normalizeAllowedPaths(taskPacket.allowedPaths, true);
			if (!allowedPaths.length) throw new Error("the TaskPacket has no allowedPaths, so the extension will not grant workspace-wide edit scope.");
			if (!ctx.hasUI) throw new Error("interactive confirmation is required.");
			const approved = await ctx.ui.confirm("Every supervisor model is out of credits. Continue with external workers?", `Task: ${taskPacket.objective}\n\nAllowed paths:\n${allowedPaths.join("\n")}`);
			if (!approved) throw new Error("rejected by the human operator.");
			const recoveryNote = `[EXTERNAL RECOVERY] The supervisor ran out of credits while handling this user request; finish only what the task above authorizes:\n${truncateUtf8(task, 2000)}`;
			const result = await executeDelegation({ recoveryNote, task: taskPacket.objective, profile: taskPacket.profile, assessment: taskPacket.assessment, implementationGuide: taskPacket.implementationGuide, acceptanceCriteria: taskPacket.acceptanceCriteria, allowedPaths, continuePrevious: Boolean(workerSession && workerSession.taskId === taskPacket.id) }, ctx.signal, undefined, ctx);
			pi.sendMessage({ customType: 'supervisor-provider-recovery', content: result.content, display: true, details: { usage: result.usage, requiresSupervisorAcceptance: true } });
		} catch (error) {
			pi.sendMessage({ customType: "supervisor-provider-recovery", content: `Automatic external recovery stopped safely: ${error instanceof Error ? error.message : String(error)}`, display: true });
		} finally {
			supervisorRecoveryRunning = false;
			updateStatus(ctx);
		}
	}

	async function activate(ctx: ExtensionContext): Promise<boolean> {
		if (config.supervisorChain.length && supervisorMode === "auto") {
			if (config.probeOnActivate) {
				ctx.ui.notify("Checking provider credits…", "info");
				await refreshCredits(ctx);
			}
			await ensureBestSupervisor(ctx, "best available");
		}
		if (!isAllowedSupervisor(ctx, config)) {
			ctx.ui.notify(`Supervisor mode requires an allowed supervisor provider (${config.allowedSupervisorProviders.join(", ")}). Current model: ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none"}.`, "error");
			return false;
		}
		if (!enabled) toolsBeforeSupervisor = pi.getActiveTools().filter((name) => !CUSTOM_TOOLS.has(name));
		enabled = true;
		applySupervisorEffort();
		pi.setActiveTools(config.supervisorTools);
		updateStatus(ctx);
		persist();
		return true;
	}

	function deactivate(ctx: ExtensionContext): void {
		enabled = false;
		pi.setActiveTools(toolsBeforeSupervisor ?? pi.getActiveTools().filter((name) => !CUSTOM_TOOLS.has(name)));
		toolsBeforeSupervisor = undefined;
		workerSession = undefined;
		ctx.ui.setStatus(STATE_TYPE, undefined);
		persist();
	}

	// ── Tools ──────────────────────────────────────────────────────────────────────────────────

	pi.registerTool({
		name: "plan_task",
		label: "Plan task",
		description: "Plan large/critical work or tasks requiring multiple delegations. Single small/medium tasks can pass profile and assessment directly to delegate_implementation. Records risk/type/scope, sets model and effort, and requests flagship approval for critical work. Do not replan corrections of the same task.",
		parameters: Type.Object({
			task: Type.String({ description: "One-sentence objective of the whole task" }),
			profile: StringEnum(PROFILE_NAMES, { description: "small = localized or mechanical change; medium = normal multi-file work; large = complex architecture or hard debugging; critical = security, concurrency, data migrations, or exceptionally complex work where a top-tier model is clearly worth it. If torn between two, choose the stronger one." }),
			rationale: Type.String({ description: "Concrete reasons for the profile: risk, scope, uncertainty" }),
			assessment: Type.Optional(assessmentSchema),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			if (!enabled) throw new Error("SupervisedCoding is disabled. Run /SupervisedCoding on.");
			if (delegationRunning) throw new Error("Wait for the running delegation before planning a task: it would replace the task that delegation is updating.");
			if (!isAllowedSupervisor(ctx, config)) throw new Error("Only an active supervisor model may plan tasks.");
			const assessment = assessTask(params.profile, params.assessment);
			params.profile = assessment.profile;
			taskPacket = {
				id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				objective: params.task,
				profile: params.profile,
				assessment: assessment.assessment,
				rationale: params.rationale,
				implementationGuide: "",
				acceptanceCriteria: [],
				allowedPaths: [],
				phase: "planned",
				promptSeq,
				flagshipDecisions: {},
				updatedAt: Date.now(),
			};
			supervisorFlagshipGrant = undefined;
			workerSession = undefined;
			const notes: string[] = [];
			if (params.profile === "critical" && supervisorMode === "auto") {
				const flagship = availableFlagshipSupervisor(ctx);
				if (flagship && !isCurrent(ctx, flagship)) {
					const name = flagship.model.name ?? flagship.candidate.model;
					if (await approveFlagship(ctx, flagship.candidate.model, name)) {
						supervisorFlagshipGrant = { taskId: taskPacket.id, provider: flagship.candidate.provider, model: flagship.candidate.model };
						notes.push(`The user approved ${name} as supervisor for this task.`);
					} else {
						notes.push(`The user declined ${name}; the strongest non-flagship supervisor stays in charge.`);
					}
				}
			}
			// Also moves off a flagship left over from a previous task.
			await ensureBestSupervisor(ctx, `task planned (${params.profile})`);
			applySupervisorEffort(params.profile);
			persist();
			updateStatus(ctx);
			const chain = config.workerChains[params.profile].map((item) => `${candidateLabel(item)}${isFlagship(item.model) ? " [flagship: the user is asked first]" : ""}`).join(" → ");
			const text = [
				`Task planned: ${params.profile}.`,
				`Task type: ${assessment.assessment.kind}; risk ${assessment.assessment.risk}; uncertainty ${assessment.assessment.uncertainty}.${assessment.reasons.length ? ` Raised profile: ${assessment.reasons.join("; ")}.` : ""}`,
				`Supervisor: ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown"}, effort ${pi.getThinkingLevel()}.`,
				`Worker chain: ${chain}.`,
				`Independent review: ${config.independentReviewProfiles.includes(params.profile) ? "automatic" : "not automatic (use consult_readonly only for concrete doubts)"}.`,
				`Minimum guide length: ${config.minImplementationGuideChars[params.profile]} characters.`,
				...notes,
				...(await learningBriefing(ctx, params.profile)),
			].join("\n");
			return { content: [{ type: "text", text }], details: { taskId: taskPacket.id, profile: params.profile } };
		},
	});

	pi.registerTool({
		name: "complete_task",
		label: "Complete supervised task",
		description: "Call after reviewing the final diff and verification results, before the final answer. Accept closes the task, records acceptance for learning and releases flagship authorization. Pause releases expensive supervision while preserving the task for a follow-up. Never accept unresolved regressions or MAJOR review findings.",
		parameters: Type.Object({
			decision: StringEnum(["accept", "pause"] as const),
			summary: Type.String({ minLength: 10, description: "Evidence for acceptance, or what is still missing." }),
			manualReview: Type.Optional(Type.Boolean({ description: "For a required independent review that was unavailable: true only if you independently reviewed the full change and explain the evidence in summary." })),
		}),
		async execute(_id, params, signal, _update, ctx) {
			if (!enabled || !taskPacket) throw new Error("No supervised task to complete.");
			if (delegationRunning) throw new Error("Wait for the running delegation before completing the task.");
			let taskReview = "";
			if (params.decision === "accept") {
				if (taskPacket.phase !== "implemented" || taskPacket.verification === "failed" || taskPacket.reviewVerdict === "major") throw new Error("Task cannot be accepted: implementation or material findings remain unresolved.");
				// Review requirements follow the strongest profile the task ever had, and cover the whole task: after
				// several delegations, per-delegation reviews saw only their own delta.
				const reviewProfile = taskPacket.maxProfile ?? taskPacket.profile;
				const reviewed = (taskPacket.reviewVerdict === "pass" || taskPacket.reviewVerdict === "minor") && taskPacket.reviewScope === "task";
				if (config.independentReviewProfiles.includes(reviewProfile) && !reviewed) {
					const review = await reviewWholeTask(ctx, reviewProfile, signal);
					if (review) {
						taskReview = `${review.text}\n\n`;
						if (review.verdict === "major") {
							updateTaskPacket({ phase: "failed", reviewVerdict: "major", reviewScope: "task" });
							return { content: [{ type: "text", text: truncateUtf8(`Task NOT accepted: the review of the whole task found material defects.\n\n${review.text}`, config.maxOutputBytes) }], details: { taskId: taskPacket.id, decision: params.decision, accepted: false }, isError: true };
						}
						if (review.verdict !== "none") updateTaskPacket({ reviewVerdict: review.verdict, reviewScope: "task" });
						else if (!params.manualReview) return { content: [{ type: "text", text: truncateUtf8(`Task NOT accepted: ${review.text}\nReview the complete change yourself, then accept with manualReview=true and the evidence in summary.`, config.maxOutputBytes) }], details: { taskId: taskPacket.id, decision: params.decision, accepted: false }, isError: true };
					} else if (!params.manualReview) {
						throw new Error("A review of the whole task is required but its starting state is unknown (e.g. after a restart): review the complete change yourself, then accept with manualReview=true and the evidence in summary.");
					}
				}
				const repo = await repoKey(ctx.cwd);
				if (config.learning.enabled) await mutateLearning(ctx, state => {
					for (const item of state.outcomes) if (item.repo === repo && item.taskId === taskPacket!.id) item.accepted = true;
					if (config.learning.autoTuneEffort) tuneEfforts(state, tuningTargets(repo, taskPacket?.assessment?.kind));
				});
				updateTaskPacket({ phase: "completed", accepted: true, lastReport: params.summary });
				workerSession = undefined;
			}
			supervisorFlagshipGrant = undefined;
			carriedTaskId = undefined;
			// Paused tasks also stop imposing their effort on this or the next prompt.
			if (taskPacket) updateTaskPacket({ promptSeq: -1, paused: params.decision === "pause" });
			applySupervisorEffort();
			// The supervisor model is not switched here: the final answer would reread the whole conversation without
			// prompt cache. The next prompt selects the best supervisor anyway.
			persist(); updateStatus(ctx);
			return { content: [{ type: "text", text: `${taskReview}Task ${params.decision === "accept" ? "accepted and completed" : "paused"}. Flagship authorization released; supervisor effort reset.` }], details: { taskId: taskPacket?.id, decision: params.decision, accepted: params.decision === "accept" } };
		},
	});

	pi.registerTool({
		name: "consult_readonly",
		label: "Read-only consultation",
		description: "Independent read-only coding analysis by a Claude or GPT model without edit or shell tools. Ask for a family different from the one that wrote the code when independence matters. Unavailable/out-of-credit reviewers are skipped automatically. Use for architecture, risk, test strategy, hard debugging, implementation review, or an audit or analysis spanning many files or large modules: the consultant reads them in its own context, not yours. Not for routine summaries.",
		parameters: Type.Object({
			purpose: StringEnum(["architecture", "risk-review", "test-strategy", "debugging", "implementation-review", "audit"] as const),
			question: Type.String({ description: "Narrow, decision-oriented question. Include known evidence; do not ask for a generic repository summary." }),
			paths: Type.Array(Type.String({ description: "Repository-relative paths to inspect" }), { minItems: 1 }),
			reviewer: Type.Optional(StringEnum(["auto", "claude", "gpt"] as const, { description: "Preferred reviewer family; the others follow if it is unavailable or out of credits. Default auto: the configured order." })),
			profile: Type.Optional(StringEnum(PROFILE_NAMES, { description: "Model/effort chain for Claude reviewers; stronger for higher risk." })),
		}),
		async execute(_id, params, signal, _update, ctx) {
			if (!enabled) throw new Error("SupervisedCoding is disabled. Run /SupervisedCoding on.");
			if (delegationRunning) throw new Error("Wait for the implementation before requesting an independent consultation.");
			if (!isAllowedSupervisor(ctx, config)) throw new Error("Only an active supervisor model may request consultations.");
			const paths = normalizeAllowedPaths(params.paths, false);
			const profileName = params.profile ?? (params.purpose === "architecture" || params.purpose === "risk-review" || params.purpose === "audit" ? "large" : "medium");
			const outcome = await runConsultation(ctx, consultOrder(params.reviewer ?? "auto", profileName), `[READ-ONLY CODING CONSULTANT]\nPurpose: ${params.purpose}`, `Question: ${params.question}`, paths, signal);
			metrics.readOnlyConsultations++;
			persist();
			updateStatus(ctx);
			const chain = outcome.attempts.length > 1 ? `\nReviewer chain: ${outcome.attempts.map((item) => `${item.label} ${item.ok ? "✓" : `✗ ${item.kind}`}`).join(" → ")}` : "";
			const warning = outcome.gitAvailable ? "" : "\n\nGit unavailable: read-only mutation verification degraded.";
			const violationText = outcome.violations.length ? `\n\nREAD-ONLY VIOLATION: ${outcome.violations.join("; ")}` : "";
			return {
				content: [{ type: "text", text: truncateUtf8(`${outcome.reviewer ?? "No reviewer"} ${outcome.failed ? "failed" : "completed"} (${profileName}).${chain}\n\n${truncateUtf8Middle(outcome.text, config.outputLimits.consultBytes)}${violationText}${warning}`, config.maxOutputBytes) }],
				details: { purpose: params.purpose, paths, profile: profileName, attempts: outcome.attempts, violations: outcome.violations },
				isError: outcome.failed,
				usage: combineUsage(outcome.usage),
			};
		},
	});

	/**
	 * Contents of the task's authorized paths when the task started, for a review of the whole task. A later
	 * delegation's new paths are added with their contents at that point; files under paths already covered are
	 * never overwritten (a file missing from the checkpoint there did not exist yet). In memory only: after a
	 * restart the task-level review falls back to the supervisor's manual review.
	 */
	const taskCheckpoints = new Map<string, { paths: string[]; checkpoint: Checkpoint }>();

	async function extendTaskCheckpoint(cwd: string, taskId: string, allowedPaths: string[], current: Checkpoint): Promise<void> {
		const known = taskCheckpoints.get(taskId);
		if (!known) {
			taskCheckpoints.clear(); // Only the current task is ever reviewed as a whole: bound the memory used.
			taskCheckpoints.set(taskId, { paths: [...allowedPaths], checkpoint: { files: { ...current.files }, complete: current.complete, omitted: [...current.omitted] } });
			return;
		}
		const extra = allowedPaths.filter((item) => !pathInAllowedScope(item, known.paths));
		if (!extra.length) return;
		const added = await checkpoint(cwd, extra);
		for (const [file, content] of Object.entries(added.files)) {
			if (!pathInAllowedScope(file, known.paths) && known.checkpoint.files[file] === undefined) known.checkpoint.files[file] = content;
		}
		known.checkpoint.complete &&= added.complete;
		known.checkpoint.omitted.push(...added.omitted);
		known.paths.push(...extra);
	}

	/** Independent review of everything the open task changed since it started; undefined when that start is unknown. */
	async function reviewWholeTask(ctx: ExtensionContext, profile: ExecutionProfileName, signal: AbortSignal | undefined): Promise<{ text: string; verdict: ReviewVerdict } | undefined> {
		const task = taskPacket;
		const start = task ? taskCheckpoints.get(task.id) : undefined;
		if (!task || !start || !task.implementer) return undefined;
		const changes = await changesSince(ctx.cwd, start.paths, start.checkpoint, config.maxDiffBytes);
		if (!changes.files.length) return { text: "Review of the whole task: no changes in the authorized paths.", verdict: "pass" };
		const criteria = task.acceptanceCriteria.length ? task.acceptanceCriteria.map((item) => `- ${item}`).join("\n") : "- Satisfy the authorized task and repository requirements.";
		const question = `Task: ${task.objective}\nAcceptance criteria:\n${criteria}\nThe task took ${task.delegationCount ?? 1} delegation(s); earlier reviews saw only single steps. Review the combined result: correctness bugs, missed requirements, regressions, inconsistencies between the steps, unsafe behavior, type/API problems and inadequate tests. If no material defect is found, say so explicitly and list residual risks.`;
		delegationRunning = true;
		let review: ConsultOutcome;
		try {
			review = await runConsultation(ctx, reviewOrder(task.implementer, profile), "[INDEPENDENT READ-ONLY CODE REVIEW OF THE WHOLE TASK]", question, changes.complete ? changes.files : start.paths, signal, { diff: changes.diff, diffComplete: changes.complete, diffLabel: "made by the whole task", requireVerdict: true, role: "review", maxTurns: config.workerMaxTurns[profile] });
		} finally {
			delegationRunning = false;
		}
		if (review.verdict !== "none") metrics.reviewVerdicts[review.verdict] = (metrics.reviewVerdicts[review.verdict] ?? 0) + 1;
		persist();
		if (review.reviewer && !review.failed) return { text: `Review of the whole task (${review.reviewer}), verdict ${review.verdict.toUpperCase()}:\n${truncateUtf8Middle(review.text, config.outputLimits.consultBytes)}`, verdict: review.verdict };
		return { text: `REVIEW OF THE WHOLE TASK UNAVAILABLE: ${review.text}${review.violations.length ? `\nREAD-ONLY VIOLATION: ${review.violations.join("; ")}` : ""}`, verdict: "none" };
	}

	async function executeDelegation(params: any, parentSignal: AbortSignal | undefined, onUpdate: any, ctx: ExtensionContext): Promise<any> {
		if (delegationRunning) throw new Error('A delegation is already running; wait for its result.');
		delegationRunning = true;
		// No timer kills a running worker: budgetExceeded() stops the delegation between phases, keeping the session.
		activeBudget = { spent: 0, deadline: config.delegationTimeoutMinutes > 0 ? Date.now() + config.delegationTimeoutMinutes * 60_000 : Infinity };
		try { return await performDelegation(params, parentSignal, onUpdate, ctx); }
		finally { activeBudget = undefined; delegationRunning = false; }
	}

	async function performDelegation(params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: ExtensionContext): Promise<any> {
			if (!enabled) throw new Error("SupervisedCoding is disabled. Run /SupervisedCoding on.");
			if (!isAllowedSupervisor(ctx, config)) throw new Error("Only an active supervisor may authorize a worker.");
			const allowedPaths = normalizeAllowedPaths(params.allowedPaths, false);
			const previousTask = openTask();
			// Same task: another delegation of this prompt, a continuation, or unfinished work carried into this prompt
			// (planned, or failed): a failed task must keep its baseline, or a fresh one would hide its regressions.
			const belongsToTask = drivesThisPrompt(previousTask) || Boolean(params.continuePrevious) || previousTask?.phase === "planned";
			const assessed = assessTask(params.profile ?? (belongsToTask ? previousTask?.profile : undefined) ?? config.defaultExecutionProfile, params.assessment ?? (belongsToTask ? previousTask?.assessment : undefined));
			const profileName = assessed.profile;
			const { guide: implementationGuide } = validateImplementationGuide(params.implementationGuide, allowedPaths, config.minImplementationGuideChars[profileName]);
			const contextUsage = ctx.getContextUsage();
			if (contextUsage?.percent !== null && contextUsage?.percent !== undefined && contextUsage.percent >= config.contextWarningPercent) {
				ctx.ui.notify(`Supervisor context is ${Math.round(contextUsage.percent)}% full. Keep review concise; compact before another broad exploration if needed.`, "warning");
			}

			// Check Git before recording the TaskPacket, so a blocked/rejected delegation leaves no active task or metrics behind.
			const gitProbe = await getGitSnapshot(ctx.cwd);
			if (!gitProbe.available) {
				if (!ctx.hasUI) throw new Error(`Delegation blocked outside Git: ${gitProbe.error ?? "Git unavailable"}. Start Pi inside a Git repository or use read-only tools.`);
				const approved = await ctx.ui.confirm("Proceed without Git safety enforcement?", `Git is unavailable in ${ctx.cwd}. allowedPaths:\n${allowedPaths.join("\n")}\n\nPost-run mutation checks will be degraded. Continue?`);
				if (!approved) throw new Error("Delegation rejected because Git safety enforcement is unavailable.");
			}

			let resumeSessionId: string | undefined;
			if (params.continuePrevious) {
				if (!workerSession || workerSession.cwd !== ctx.cwd) throw new Error("Cannot continue: no compatible previous worker session is available.");
				// A follow-up step of the same open task may reuse the session on new paths (it already knows the code);
				// scope is still enforced after the run. A different task never inherits a session.
				const sameTask = Boolean(workerSession.taskId && workerSession.taskId === openTask()?.id);
				if (!sameTask) throw new Error("Cannot continue a different or completed task. Plan a fresh task.");
				resumeSessionId = workerSession.sessionId;
			} else {
				workerSession = undefined;
			}

			const criteria: string[] = params.acceptanceCriteria ?? [];
			// A delegation belongs to the open task (planned with plan_task or already in progress): its flagship answers carry over.
			// Same task: planned with plan_task, a correction (continuePrevious), or another delegation of the same user prompt.
			const current = openTask();
			const open = current && belongsToTask ? current : undefined;
			taskPacket = {
				id: open?.id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				promptSeq,
				rationale: open?.rationale,
				flagshipDecisions: open?.flagshipDecisions,
				objective: params.task,
				profile: profileName,
				assessment: assessed.assessment,
				implementationGuide: implementationGuide,
				acceptanceCriteria: criteria,
				allowedPaths: [...allowedPaths],
				phase: "implementing",
				// The task-start reference travels with the task: re-recording it later would hide earlier regressions.
				baseline: open?.baseline,
				baselineSignatures: open?.baselineSignatures,
				delegationCount: (open?.delegationCount ?? 0) + 1,
				maxProfile: PROFILE_NAMES[Math.max(PROFILE_NAMES.indexOf(profileName), PROFILE_NAMES.indexOf(open?.maxProfile ?? profileName))],
				implementer: open?.implementer,
				updatedAt: Date.now(),
			};
			metrics.delegations++;
			if (profileName === "critical" && supervisorMode === "auto") {
				const flagship = availableFlagshipSupervisor(ctx);
				if (flagship && await approveFlagship(ctx, flagship.candidate.model, flagship.model.name ?? flagship.candidate.model)) supervisorFlagshipGrant = { taskId: taskPacket.id, provider: flagship.candidate.provider, model: flagship.candidate.model };
			}
			applySupervisorEffort(profileName);
			await ensureBestSupervisor(ctx, `task profile ${profileName}`);
			persist();

			try {
				const repoContext = await repoContextFor(ctx.cwd, allowedPaths);
				const verifyCommands = config.autoVerify ? dedupeVerifyCommands(ctx.cwd, extractVerifyCommands(implementationGuide, config.verificationCommands, UNSAFE_COMMAND_CHARS)) : [];
				// Baseline first: checks that already failed are reported, never blamed on (or credited to) the worker.
				// A check counts as pre-existing only if it fails now AND failed when the task started: whatever an
				// earlier delegation of the same task broke is still a regression of the task, to be fixed here.
				// Even then it is tolerated only while it fails the same way it failed at the start (see classifyCheck).
				const taskBaseline: Record<string, boolean> = { ...taskPacket.baseline };
				const taskSignatures: Record<string, string> = { ...taskPacket.baselineSignatures };
				const baseline = new Map<string, boolean>();
				const reusedAtStart: string[] = [];
				// Files written by checks (build output, caches) are reported, never counted as worker scope violations.
				const checkChanges = new Set<string>();
				// Branch, HEAD or index changes by any check run of this delegation: they fail it, whoever's fault.
				const checkSafety = new Set<string>();
				const collect = (check: CheckResult) => {
					check.changed.forEach((file) => checkChanges.add(file));
					check.safetyViolations.forEach((item) => checkSafety.add(`${check.command}: ${item}`));
				};
				for (const command of verifyCommands) {
					const check = await runCheck(ctx, command, signal, true);
					collect(check);
					if (check.reused) reusedAtStart.push(command);
					if (check.safetyViolations.length) break;
					// A task persisted before signatures existed adopts this delegation's start as its reference: the
					// best evidence left, and still stricter than the old boolean.
					if (taskBaseline[command] === undefined || (taskBaseline[command] === false && taskSignatures[command] === undefined && check.signature)) {
						taskBaseline[command] ??= check.ok;
						if (check.signature) taskSignatures[command] = check.signature;
					}
					baseline.set(command, check.ok || taskBaseline[command]);
				}
				// A check that moved the branch, HEAD or index leaves Git in a state no worker may build on: stop before
				// any worker starts, and record no baseline from it.
				if (checkSafety.size) {
					const changedNote = checkChanges.size ? `\nVerification commands also changed files: ${[...checkChanges].join(", ")}` : "";
					const report = `DELEGATION BLOCKED before any worker started: verification commands changed Git state at the task start.\nGIT SAFETY VIOLATION: ${[...checkSafety].join("; ")}.\nReview manually (branch, HEAD, staged files); no automatic revert was attempted. Fix the VERIFY commands or the scripts they run before delegating again.${changedNote}`;
					workerSession = undefined;
					metrics.failedDelegations++;
					updateTaskPacket({ phase: "failed", verification: "failed", failedChecks: undefined, lastReport: report });
					updateStatus(ctx);
					return {
						content: [{ type: "text", text: truncateUtf8(report, config.maxOutputBytes) }],
						details: { attempts: [], profile: profileName, taskPacketId: taskPacket?.id, verification: "failed", verificationSafetyViolations: [...checkSafety], verificationChanged: [...checkChanges], scopeViolations: [], correctionRounds: 0, reviewVerdict: "none", sessionPreserved: false, workerStarted: false },
						isError: true,
					};
				}
				updateTaskPacket({ baseline: taskBaseline, baselineSignatures: taskSignatures });
				const classify = (check: CheckResult) => classifyCheck(check, baseline.get(check.command) === false, taskSignatures[check.command]);
				const regressionsIn = (checks: CheckResult[]) => checks.filter((check) => ["regression", "changed"].includes(classify(check)));
				// One command at a time: after a check changes the branch, HEAD or index, no later check runs on that state
				// (and only the checks that ran are reported).
				const runVerifyChecks = async () => {
					const checks: CheckResult[] = [];
					for (const command of verifyCommands) {
						const check = await runCheck(ctx, command, signal);
						collect(check);
						checks.push(check);
						if (check.safetyViolations.length) break;
					}
					return checks;
				};
				const beforeContent = await checkpoint(ctx.cwd, allowedPaths);
				await extendTaskCheckpoint(ctx.cwd, taskPacket.id, allowedPaths, beforeContent);
				const spec: ImplementationSpec = { task: params.recoveryNote ? `${params.task}\n\n${params.recoveryNote}` : params.task, guide: implementationGuide, criteria, allowedPaths, profileName, assessment: assessed.assessment, preferWorker: params.preferWorker, effort: params.effort, resumeSessionId, resumeWorker: workerSession?.worker ?? "claude", resumeModel: workerSession?.model, repoContext, checkpoint: beforeContent };
				checkResults.clear();
				const outcome = await executeImplementation(ctx, spec, signal, (text, label) => onUpdate?.({ content: [{ type: "text", text: truncateUtf8(text, 4000) }], details: { running: true, profile: profileName, worker: label } }));
				if (outcome.resumed) metrics.resumedDelegations++;
				let final = outcome.final as RunResult;
				let implementer = outcome.finalCandidate as WorkerCandidate;
				// Learning credits the delegation to the model that did the work; a model that only rescued a
				// correction after a provider failure must not be charged with the first model's regression.
				const initialImplementer = implementer;
				let limitReached = outcome.limitReached;
				const usage = [...outcome.usage];
				let sessionId = final.sessionId;
				let failed = outcome.failed;
				let providerFailure = runFailed(final) && (FAILOVER_KINDS.has(failureKindOf(final)) || failureKindOf(final) === "transient");

				// Automatic verification with a bounded correction loop: the worker fixes its own regressions with its context intact.
				let verification: VerificationResult = "unverified";
				let verificationText = "";
				let correctionRounds = 0;
				// Scope/Git safety covers only worker runs (the implementation and each correction), each against its own
				// snapshots: files written by the checks in between are not the worker's doing.
				const scopeViolations = [...outcome.scopeViolations];
				let regressions: CheckResult[] = [];
				let correctionFailed = false;
				/** Commands of the last check run: fewer than VERIFY lists when a Git safety violation stopped it. */
				let ranCommands = verifyCommands;
				if (!failed && verifyCommands.length) {
					metrics.autoVerifiedDelegations++;
					let checks = await runVerifyChecks();
					regressions = regressionsIn(checks);
					const notes: string[] = [];
					// No correction round ever starts on Git state a check changed (branch, HEAD, index): the worker
					// would build on it. This also ends the loop right after any later check run that changes it.
					while (regressions.length && !checkSafety.size && correctionRounds < config.maxCorrectionRounds) {
						const over = budgetExceeded();
						if (over) {
							limitReached = over;
							notes.push(`No further correction round: ${over} reached; the worker session is preserved.`);
							break;
						}
						correctionRounds++;
						metrics.correctionRounds++;
						onUpdate?.({ content: [{ type: "text", text: `Correction round ${correctionRounds}: ${regressions.map((check) => check.command).join(", ")} failing` }], details: { running: true, profile: profileName, worker: candidateLabel(implementer) } });
						checkResults.clear();
						const correction = await runCorrection(ctx, implementer, sessionId, spec, regressions, correctionRounds, signal);
						usage.push(...correction.usage);
						scopeViolations.push(...correction.scopeViolations);
						if (correction.final) { final = correction.final; sessionId = final.sessionId; }
						if (correction.finalCandidate) implementer = correction.finalCandidate;
						if (correction.limitReached) {
							limitReached = correction.limitReached;
							notes.push(`Correction round ${correctionRounds} stopped at the ${correction.limitReached}; the worker session is preserved.`);
							break;
						}
						if (correction.failed) {
							correctionFailed = true;
							providerFailure = runFailed(final) && (FAILOVER_KINDS.has(failureKindOf(final)) || failureKindOf(final) === "transient");
							notes.push(`Correction round ${correctionRounds} failed: ${correction.primaryOutput.slice(0, 200)}`);
							break;
						}
						sessionId = final.sessionId ?? sessionId;
						checks = await runVerifyChecks();
						regressions = regressionsIn(checks);
					}
					verification = regressions.length ? "failed" : checks.some(check => !check.ok) ? "unchanged_failures" : correctionRounds ? "fixed" : "passed";
					if (regressions.length) failed = true;
					if (checkSafety.size) {
						verification = "failed";
						notes.push(`GIT SAFETY VIOLATION by verification commands: ${[...checkSafety].join("; ")}. Automation stopped: no correction round, worker session not kept. Review manually; no automatic revert was attempted.`);
					}
					if (checkChanges.size) notes.push(`Warning: verification commands changed files (not counted as scope violations of the worker): ${[...checkChanges].join(", ")}`);
					ranCommands = checks.map((check) => check.command);
					const skipped = verifyCommands.filter((command) => !ranCommands.includes(command));
					if (skipped.length) notes.push(`Not run on the changed Git state: ${skipped.join(", ")}.`);
					verificationText = formatChecks(checks, classify, correctionRounds, verification, notes, (taskPacket?.delegationCount ?? 1) === 1);
				}
				if (checkSafety.size) { verification = "failed"; failed = true; }

				const afterAll = await getGitSnapshot(ctx.cwd);
				if (scopeViolations.length) failed = true;
				// Never resumable on Git state a check changed: continuePrevious would resume the worker on it.
				workerSession = implementer.worker !== "api" && sessionId && !scopeViolations.length && !checkSafety.size
					? { worker: implementer.worker, sessionId, cwd: ctx.cwd, allowedPaths: [...allowedPaths], model: implementer.model, taskId: taskPacket?.id }
					: undefined;
				const report = `${outcome.primaryOutput}${verificationText ? `\n\n${verificationText}` : ""}`;
				// Only a task failed by its checks alone can be restored by passing checks (run_verification).
				const onlyChecksFailed = regressions.length > 0 && !outcome.failed && !correctionFailed && !limitReached && !scopeViolations.length && !checkSafety.size;
				updateTaskPacket({ phase: failed ? "failed" : "implemented", primaryWorker: candidateLabel(implementer), implementer, lastReport: report, verification, failedChecks: onlyChecksFailed ? regressions.map((check) => check.command) : undefined });

				let reviewText = "";
				let reviewVerdict: ReviewVerdict = "none";
				const reviewBudget = budgetExceeded();
				if (!failed && config.independentReviewProfiles.includes(profileName) && reviewBudget) {
					reviewText = `INDEPENDENT REVIEW SKIPPED (${reviewBudget} reached). complete_task will review the whole task before accepting it.`;
				} else if (!failed && config.independentReviewProfiles.includes(profileName)) {
					updateTaskPacket({ phase: "reviewing" });
					const question = `Task: ${params.task}\nAcceptance criteria:\n${criteria.length ? criteria.map((item) => `- ${item}`).join("\n") : "- Satisfy the authorized task and repository requirements."}\n${verificationText ? `\nAutomatic checks: ${verification}.\n` : ""}\nLook for correctness bugs, missed requirements, regressions, unsafe behavior, type/API problems, and inadequate tests. If no material defect is found, say so explicitly and list residual risks.`;
					const changes = await changesSince(ctx.cwd, allowedPaths, beforeContent, config.maxDiffBytes);
					const reviewPaths = [...new Set([...changes.files, ...allowedPaths.filter(p => !fs.existsSync(path.join(ctx.cwd, p)) || !fs.statSync(path.join(ctx.cwd, p)).isDirectory())])];
					const review = await runConsultation(ctx, reviewOrder(implementer, profileName), "[INDEPENDENT READ-ONLY CODE REVIEW]", question, changes.complete ? reviewPaths : allowedPaths, signal, { diff: changes.diff, diffComplete: changes.complete, requireVerdict: true, role: "review", maxTurns: config.workerMaxTurns[profileName] });
					usage.push(...review.usage);
					reviewVerdict = review.verdict;
					reviewText = review.reviewer && !review.failed
						? `Independent review (${review.reviewer}), verdict ${reviewVerdict.toUpperCase()}:\n${review.text}`
						: `INDEPENDENT REVIEW UNAVAILABLE: ${review.text}${review.violations.length ? `\nREAD-ONLY VIOLATION: ${review.violations.join("; ")}` : ""}\nReview the diff yourself before accepting.`;
					if (review.violations.length || reviewVerdict === "major") failed = true;
					// The first delegation's diff is the whole task so far; later ones cover only their own delta.
					updateTaskPacket({ phase: failed ? "failed" : "implemented", lastReport: `${report}\n\n${reviewText}`, reviewVerdict, reviewScope: taskPacket.delegationCount === 1 ? "task" : "delegation" });
				}

				const combined = combineUsage(usage);
				// The turn limit says the model/effort did not finish the work; time and cost limits are the extension's own.
				const budgetStop = Boolean(limitReached && !limitReached.startsWith("worker turn limit"));
				const learningNotes = await learnFromDelegation(ctx, { implementer: initialImplementer, final, profileName, verification, correctionRounds, reviewVerdict, failed, providerFailure, budgetStop, combined });
				if (verification === "passed" && !failed) metrics.firstPassDelegations++;
				if (failed) metrics.failedDelegations++;
				if (reviewVerdict !== "none") metrics.reviewVerdicts[reviewVerdict] = (metrics.reviewVerdicts[reviewVerdict] ?? 0) + 1;
				persist();
				updateStatus(ctx);
				const usageLine = combined ? `Combined tokens: ${combined.input} in + ${combined.output} out + ${combined.cacheRead} cache-read; reported cost $${combined.cost.total.toFixed(2)}` : "Usage unavailable";
				const safetyItems = [...scopeViolations, ...[...checkSafety].map((item) => `verification ${item}`)];
				const safetyLine = safetyItems.length ? `SAFETY VIOLATIONS: ${safetyItems.join("; ")}\n` : "";
				const changedLine = afterAll.available ? `Changed files in this delegation: ${filesChangedBetween(outcome.before, afterAll).join(", ") || "none"}\n` : "Git unavailable: scope enforcement degraded outside Git repositories.\n";
				// The supervisor reviews the change right here instead of spending extra turns on supervisor_git.
				const delta = afterAll.available ? await changesSince(ctx.cwd, allowedPaths, beforeContent, 12_000) : undefined;
				const diffSection = delta?.complete ? `DIFF (this delegation only)\n\`\`\`diff\n${delta.diff}\n\`\`\`` : delta ? `DIFF: incomplete; inspect with supervisor_git. Changed paths: ${delta.files.join(", ")}.` : "";
				const verificationLine = verifyCommands.length
					? `Automatic verification: ${verification}${correctionRounds ? ` after ${correctionRounds} correction round(s)` : ""} — already run by the extension on the final code: ${ranCommands.join(", ")}. Do not re-run these; use run_verification only for other checks.\n`
					: "Automatic verification: none (no allowlisted command in VERIFY); run_verification before accepting.\n";
				// Each part has its own cap, so a long worker report can never push the review or the diff out of the result.
				const sections = [
					`${candidateLabel(implementer)} (${profileName}) ${limitReached ? "stopped" : failed ? "failed" : "completed"}.\n${limitReached ? `STOPPED: ${limitReached} reached. Partial work${workerSession ? " and the worker session are" : " is"} preserved; delegate the rest with continuePrevious=true.\n` : ""}${safetyLine}${changedLine}${verificationLine}${usageLine}`,
					truncateUtf8Middle(outcome.primaryOutput, config.outputLimits.workerReportBytes),
					verificationText,
					truncateUtf8Middle(reviewText, config.outputLimits.consultBytes),
					learningNotes.length ? `Learning: ${learningNotes.join("; ")}` : "",
				];
				const withoutDiff = Buffer.byteLength(sections.join("\n\n"), "utf8");
				// A diff is useful only whole: when it does not fit, point to it instead of cutting it.
				sections.splice(4, 0, diffSection && withoutDiff + Buffer.byteLength(diffSection, "utf8") + 2 > config.maxOutputBytes && delta
					? `DIFF: omitted to keep this result within maxOutputBytes; inspect with supervisor_git. Changed paths: ${delta.files.join(", ")}.`
					: diffSection);
				const text = truncateUtf8(sections.filter(Boolean).join("\n\n"), config.maxOutputBytes);
				return {
					content: [{ type: "text", text }],
					details: { attempts: outcome.attempts, implementer, before: outcome.before, after: afterAll, scopeViolations, verificationChanged: [...checkChanges], verificationSafetyViolations: [...checkSafety], verificationCommandsRun: verification === "unverified" ? [] : ranCommands, checksReusedAtStart: reusedAtStart, profile: profileName, resumed: outcome.resumed, taskPacketId: taskPacket?.id, verification, correctionRounds, reviewVerdict, limitReached, sessionPreserved: Boolean(workerSession && workerSession.taskId === taskPacket?.id) },
					isError: failed,
					usage: combined,
				};
			} catch (error) {
				metrics.failedDelegations++;
				// Never leave a stale "implementing" packet behind: recovery logic relies on the phase being accurate.
				updateTaskPacket({ phase: "failed", lastReport: `Delegation aborted: ${error instanceof Error ? error.message : String(error)}` });
				throw error;
			}
	}

	pi.registerTool({
		name: "delegate_implementation",
		label: "Delegate implementation",
		description: "Authorize an implementation for the open task. The extension picks the best worker for the profile (Claude or GPT, in the configured quality order adjusted by evidence), skips providers out of credits, retries transient errors, and hands off to the next candidate on credit/auth/availability failures. Flagship models run only on critical tasks after the user approves them. The profile defaults to the one recorded by plan_task.",
		parameters: Type.Object({
			task: Type.String({ description: "Concise implementation objective; do not repeat the file guide" }),
			profile: Type.Optional(StringEnum(PROFILE_NAMES, { description: `Complexity profile; defaults to the plan_task profile, else ${config.defaultExecutionProfile}. Prefer the stronger profile whenever quality is uncertain.` })),
			assessment: Type.Optional(assessmentSchema),
			effort: Type.Optional(StringEnum(WORKER_EFFORTS, { description: "Raise the profile's Claude effort only when this specific change clearly needs more reasoning (tricky algorithm, subtle concurrency). Lowering is honored only for the small profile; otherwise the profile's effort is kept, because quality comes first." })),
			preferWorker: Type.Optional(StringEnum(["claude", "gpt"] as const, { description: "Model family to try first, only when it is clearly better suited to this change. Other candidates remain as fallback." })),
			continuePrevious: Type.Optional(Type.Boolean({ description: "Resume the previous worker session (Claude or Pi) for a correction/follow-up of the same open task. Each call carries the currently authorized paths." })),
			implementationGuide: Type.String({ minLength: Math.min(...Object.values(config.minImplementationGuideChars)), description: "Guide using FILE:, SYMBOLS:, CHANGES:, PRESERVE:, VERIFY:. Be concise where possible, but include every detail needed for reliable execution and mention every allowed path." }),
			acceptanceCriteria: Type.Optional(Type.Array(Type.String({ description: "Concrete, non-duplicative checks" }))),
			allowedPaths: Type.Array(Type.String({ description: "Relative path for every file the worker may modify" }), { minItems: 1 }),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			return executeDelegation(params, signal, onUpdate, ctx);
		},
	});

	pi.registerTool({
		name: "run_verification",
		label: "Run verification",
		description: "Run one allowlisted verification missing from automatic VERIFY, or invalidated by subsequent changes. Do not repeat checks already run on the same final code. Returns the end of long output and warns about file changes. Shell operators are rejected.",
		parameters: Type.Object({
			command: Type.String({ description: `Must start with one of: ${config.verificationCommands.join(", ")}` }),
		}),
		async execute(_id, params, signal, _update, ctx) {
			if (!enabled) throw new Error("SupervisedCoding is disabled. Run /SupervisedCoding on.");
			if (delegationRunning) throw new Error("Wait for the running delegation before starting another verification.");
			const command = params.command.trim().replace(/\s+/g, " ");
			if (UNSAFE_COMMAND_CHARS.test(command)) throw new Error("run_verification rejects shell operators, redirections and variables; pass a single plain command.");
			if (!config.verificationCommands.some((prefix) => command === prefix || command.startsWith(`${prefix} `))) {
				throw new Error(`Command not allowlisted. Allowed prefixes: ${config.verificationCommands.join(", ")} (verificationCommands in config.json).`);
			}
			const check = await runCheck(ctx, command, signal);
			// A failure blocks acceptance of the open task, unless the check was already red when the task started and
			// still fails the same way. A completed task is never reopened by a later check.
			const open = openTask();
			const state = open ? classifyCheck(check, open.baseline?.[command] === false, open.baselineSignatures?.[command]) : undefined;
			if (check.safetyViolations.length) {
				// No worker may be resumed (continuePrevious) on Git state a check changed, whatever task it belongs to.
				workerSession = undefined;
				persist();
			}
			if (open && check.safetyViolations.length) {
				// Branch, HEAD or index changes are never cleared by a later passing check.
				updateTaskPacket({ verification: "failed", phase: "failed", failedChecks: undefined });
			} else if (open && (state === "regression" || state === "changed")) {
				// Checks stay the only failure of a task that was implemented, or already failed by checks alone.
				const onlyChecks = open.phase === "implemented" || (open.phase === "failed" && open.failedChecks !== undefined);
				updateTaskPacket({ verification: "failed", phase: "failed", failedChecks: onlyChecks ? [...new Set([...(open.failedChecks ?? []), command])] : undefined });
			} else if (open && (state === "pass" || state === "unchanged") && open.phase === "failed" && open.verification === "failed" && open.failedChecks?.includes(command)) {
				// A check that failed the task is cleared once it passes, or fails again only the way it did at the task
				// start (the added failure was fixed). The task returns to implemented when none is left; other failures never clear.
				const remaining = open.failedChecks.filter((item) => item !== command);
				updateTaskPacket(remaining.length ? { failedChecks: remaining } : { verification: state === "unchanged" ? "unchanged_failures" : "passed", phase: "implemented", failedChecks: undefined });
			} else if (open && state === "pass" && open.phase === "implemented" && open.verification === "unverified") {
				updateTaskPacket({ verification: "passed" });
			}
			const status = check.timedOut ? `timed out after ${config.verificationTimeoutMinutes} min` : `exit code ${check.exitCode}`;
			const stateLine = state && state !== "pass" ? `\n${CHECK_STATE_TEXT[state]}` : "";
			const safety = check.safetyViolations.length ? `\nGIT SAFETY VIOLATION: ${check.safetyViolations.join("; ")}. Review manually; no automatic revert was attempted.` : "";
			const warning = check.changed.length ? `\n\nNote: the command changed files: ${check.changed.join(", ")}` : "";
			return {
				// A passing check needs only its summary; a failing one its failures, which runners print last.
				content: [{ type: "text", text: `$ ${command}\n${status}${stateLine}${safety}${warning}\n\n${truncateUtf8Tail(check.output, Math.min(check.ok ? config.outputLimits.verificationPassBytes : config.outputLimits.verificationFailBytes, config.maxOutputBytes))}` }],
				details: { command, exitCode: check.exitCode, timedOut: check.timedOut, changed: check.changed, safetyViolations: check.safetyViolations, state, taskPhase: open ? taskPacket?.phase : undefined, verification: open ? taskPacket?.verification : undefined },
				isError: !check.ok || check.safetyViolations.length > 0,
			};
		},
	});

	pi.registerTool({
		name: "code_outline",
		label: "Code outline",
		description: "Outline of source files without reading them: functions, classes, methods, types and tests (Markdown: headings) with their line ranges. Use it before reading a large or unfamiliar file, then read only the ranges you need (read with offset/limit). Directories list the supported files Git does not ignore. With references, it lists instead where each symbol is used, each line with the function or class that contains it (to judge a change's impact); paths then limit the search (default: the whole repository). Deterministic, no model call; ranges are approximate for unconventionally formatted code, references match by name.",
		parameters: Type.Object({
			paths: Type.Optional(Type.Array(Type.String({ description: "Repository-relative file or directory" }), { minItems: 1, maxItems: 50 })),
			references: Type.Optional(Type.Array(Type.String({ description: "Symbol name, e.g. runCheck or Store.add" }), { minItems: 1, maxItems: 5 })),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			if (!enabled) throw new Error("SupervisedCoding is disabled. Run /SupervisedCoding on.");
			if (params.references) {
				const text = await findReferences(ctx.cwd, params.references, normalizeAllowedPaths(params.paths ?? ["."], true));
				return { content: [{ type: "text", text: truncateUtf8(text, config.outputLimits.outlineBytes) }], details: { references: params.references } };
			}
			if (!params.paths) throw new Error("code_outline needs paths to outline, or references to look up.");
			const files = await outlineFiles(ctx.cwd, normalizeAllowedPaths(params.paths, true));
			const parts: string[] = [];
			let bytes = 0;
			let omitted = 0;
			for (const file of files.list) {
				let source: string;
				try {
					const buffer = fs.readFileSync(path.join(ctx.cwd, file));
					if (buffer.includes(0)) continue;
					source = buffer.toString("utf8");
				} catch {
					continue; // Deleted in the working tree.
				}
				const part = formatOutline(file, source);
				bytes += Buffer.byteLength(part, "utf8") + 2;
				if (bytes > config.outputLimits.outlineBytes && parts.length) { omitted++; continue; }
				parts.push(part);
			}
			const notes = [
				...files.missing.map((item) => `${item}: not found`),
				...(files.capped ? [`More than ${OUTLINE_MAX_FILES} files: outline a narrower directory.`] : []),
				...(omitted ? [`${omitted} more file(s) omitted to stay within outputLimits.outlineBytes: outline them separately.`] : []),
			];
			const text = [...parts, ...(notes.length ? [notes.join("\n")] : [])].join("\n\n") || "No supported source files in these paths.";
			return {
				content: [{ type: "text", text: truncateUtf8(text, config.outputLimits.outlineBytes + 1024) }],
				details: { files: parts.length, omitted, missing: files.missing, capped: files.capped },
			};
		},
	});

	pi.registerTool({
		name: "record_lesson",
		label: "Record repository lesson",
		description: "Record a durable, repository-specific lesson that future workers must know, after it caused a failure, a correction round or a review finding. Examples: a required build step before tests, a non-obvious convention, a fragile module. Never record task-specific details, secrets or one-off facts. Lessons are injected into every future worker prompt for this repository.",
		parameters: Type.Object({
			lesson: Type.String({ description: "One concrete, reusable instruction (max 300 characters), e.g. \"Run `npm run build` before `npm test`: tests import from dist/.\"" }),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			if (!enabled) throw new Error("SupervisedCoding is disabled. Run /SupervisedCoding on.");
			if (!config.learning.enabled) throw new Error("Learning is disabled in config.json (learning.enabled).");
			const repo = await repoKey(ctx.cwd);
			let added: ReturnType<typeof addLesson> | undefined;
			await mutateLearning(ctx, state => { added = addLesson(state, repo, params.lesson); });
			if (!added) throw new Error("Lesson was not saved; retry after the learning store is available.");
			const { lesson, duplicate } = added;
			return {
				content: [{ type: "text", text: duplicate ? `Lesson already known; reinforced (${lesson.id}): ${lesson.text}` : `Lesson recorded (${lesson.id}): ${lesson.text}\nIt will be given to every future worker in this repository.` }],
				details: { id: lesson.id, duplicate, repo },
			};
		},
	});

	pi.registerTool({
		name: "supervisor_git",
		label: "Supervisor Git inspection",
		description: "Read-only, scopeable Git inspection. Prefer diff-stat/diff-names, then request diff only for relevant paths with minimal sufficient context.",
		parameters: Type.Object({
			action: StringEnum(["status", "diff", "diff-staged", "diff-stat", "diff-names", "log"] as const),
			paths: Type.Optional(Type.Array(Type.String({ description: "Literal repository-relative path to inspect" }), { minItems: 1 })),
			unifiedLines: Type.Optional(Type.Integer({ minimum: 0, maximum: 50, description: "Diff context lines; defaults to 3" })),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const paths = params.paths ?? [];
			const pathArgs = ["--", ...paths];
			const unified = `--unified=${params.unifiedLines ?? 3}`;
			const argsByAction: Record<typeof params.action, string[]> = {
				status: ["status", "--short", "--branch", ...pathArgs],
				diff: ["diff", "--no-ext-diff", unified, ...pathArgs],
				"diff-staged": ["diff", "--cached", "--no-ext-diff", unified, ...pathArgs],
				"diff-stat": ["diff", "--stat", ...pathArgs],
				"diff-names": ["diff", "--name-only", ...pathArgs],
				log: ["log", "-10", "--oneline", "--decorate", ...pathArgs],
			};
			let output = await runGit(ctx.cwd, argsByAction[params.action]);
			if (params.action === "diff-names" || params.action === "diff-stat") {
				const untracked = await safeRunGit(ctx.cwd, ["ls-files", "--others", "--exclude-standard", ...pathArgs]);
				if (untracked.ok && untracked.output !== "(no output)") {
					output = output === "(no output)" ? `Untracked files:\n${untracked.output}` : `${output}\n\nUntracked files:\n${untracked.output}`;
				}
			}
			metrics.gitInspectionBytes += Buffer.byteLength(output, "utf8");
			return {
				content: [{ type: "text", text: truncateUtf8(output, config.maxOutputBytes) }],
				details: { action: params.action, paths, unifiedLines: params.unifiedLines ?? 3, outputBytes: Buffer.byteLength(output, "utf8") },
			};
		},
	});

	pi.registerTool({
		name: "request_git_commit",
		label: "Request human-authorized commit",
		description: "Stage literal paths and create a commit only after explicit human confirmation in the UI.",
		parameters: Type.Object({ message: Type.String(), paths: Type.Array(Type.String(), { minItems: 1 }) }),
		async execute(_id, params, _signal, _update, ctx) {
			if (delegationRunning) throw new Error("Commit blocked: wait for the running delegation; its worker may still be changing files.");
			if (!ctx.hasUI) throw new Error("Commit blocked: interactive human authorization is unavailable.");
			const commitPaths = normalizeAllowedPaths(params.paths, false);
			if (taskPacket?.allowedPaths?.length && !taskPacket.allowedPaths.includes(".")) {
				const outsideTask = commitPaths.filter((item) => !pathInAllowedScope(item, taskPacket?.allowedPaths ?? []));
				if (outsideTask.length) throw new Error(`Commit blocked: paths outside current task allowlist: ${outsideTask.join(", ")}`);
			}
			const alreadyStaged = await runGit(ctx.cwd, ["diff", "--cached", "--name-only", "--"]);
			if (alreadyStaged !== "(no output)") throw new Error(`Commit blocked: the index already contains staged files. Review or unstage them first:\n${alreadyStaged}`);
			const approved = await ctx.ui.confirm("Authorize Git commit?", `Message: ${params.message}\n\nPaths:\n${commitPaths.join("\n")}`);
			if (!approved) throw new Error("Commit rejected by the human operator.");
			await runGit(ctx.cwd, ["--literal-pathspecs", "add", "--", ...commitPaths]);
			const output = await runGit(ctx.cwd, ["commit", "-m", params.message]);
			// Committing is not a substitute for the supervisor's complete_task acceptance.
			return { content: [{ type: "text", text: output }], details: { approved: true } };
		},
	});

	pi.registerTool({
		name: "request_git_push",
		label: "Request human-authorized push",
		description: "Run a normal git push, never force-push, only after explicit human confirmation in the UI.",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _update, ctx) {
			if (delegationRunning) throw new Error("Push blocked: wait for the running delegation to finish.");
			if (!ctx.hasUI) throw new Error("Push blocked: interactive human authorization is unavailable.");
			const branch = await runGit(ctx.cwd, ["branch", "--show-current"]);
			if (!branch || branch === "(no output)") throw new Error("Push blocked: detached HEAD; cannot determine current branch to push.");
			const approved = await ctx.ui.confirm("Authorize Git push?", `Branch: ${branch}\n\nThis runs a normal git push. Force-push is not supported.`);
			if (!approved) throw new Error("Push rejected by the human operator.");
			const output = await runGit(ctx.cwd, ["push"]);
			return { content: [{ type: "text", text: output }], details: { approved: true, branch } };
		},
	});

	// ── Commands ───────────────────────────────────────────────────────────────────────────────

	pi.registerCommand(EXTENSION_NAME, {
		description: "Supervised coding: on | off | status | credits [refresh|reset] | model [auto|manual] | learning [forget <id>|reset]",
		handler: async (args, ctx) => {
			const [action = "status", sub = "", arg = ""] = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
			if (action === "on") {
				if (await activate(ctx)) ctx.ui.notify(`${EXTENSION_NAME} enabled on ${ctx.model?.provider}/${ctx.model?.id}. Worker chain (${config.defaultExecutionProfile}): ${config.workerChains[config.defaultExecutionProfile].map(candidateLabel).join(" → ")}`, "info");
				return;
			}
			if (action === "off") {
				deactivate(ctx);
				ctx.ui.notify(`${EXTENSION_NAME} disabled; previous tools restored and worker continuation discarded.`, "info");
				return;
			}
			if (action === "credits") {
				if (sub === "reset") {
					health = {};
					persist();
					ctx.ui.notify("Credit/limit state cleared; every provider will be tried again.", "info");
					return;
				}
				if (sub === "refresh") ctx.ui.notify((await refreshCredits(ctx, true)).join("\n"), "info");
				ctx.ui.notify(creditsReport(ctx), "info");
				return;
			}
			if (action === "model") {
				if (sub === "auto" || sub === "manual") {
					supervisorMode = sub;
					persist();
					if (sub === "auto") await ensureBestSupervisor(ctx, "auto selection enabled");
					updateStatus(ctx);
				}
				ctx.ui.notify(`Supervisor model selection: ${supervisorMode}. ${supervisorMode === "manual" ? "Credit failover still switches away from an exhausted model." : "The best available model in supervisorChain is used for every new prompt."}\n\n${creditsReport(ctx)}`, "info");
				return;
			}
			if (action === "learning") {
				if (sub === "reset") {
					const approved = !ctx.hasUI || (await ctx.ui.confirm("Reset SupervisedCoding learning?", "This deletes all recorded outcomes, calibrated efforts and lessons for every repository."));
					if (!approved) return;
					await mutateLearning(ctx, state => { state.outcomes = []; state.lessons = []; state.effortAdjustments = {}; state.sequence = 0; });
					ctx.ui.notify("Learning data cleared.", "info");
					return;
				}
				if (sub === "forget") {
					let removed = false;
					await mutateLearning(ctx, state => { removed = removeLesson(state, arg); });
					ctx.ui.notify(removed ? `Lesson ${arg} removed.` : `No lesson with id "${arg}".`, "info");
					return;
				}
				ctx.ui.notify(await learningReport(ctx), "info");
				return;
			}
			ctx.ui.notify([
				`${EXTENSION_NAME}: ${enabled ? "ON" : "OFF"} · supervisor ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none"} (${supervisorMode}, effort ${pi.getThinkingLevel()})`,
				`Task: ${taskPacket ? `${taskPacket.phase} · ${taskPacket.profile} · ${taskPacket.id}${taskPacket.flagshipDecisions && Object.keys(taskPacket.flagshipDecisions).length ? ` · flagship answers: ${Object.entries(taskPacket.flagshipDecisions).map(([model, yes]) => `${model}=${yes ? FLAGSHIP_YES : FLAGSHIP_NO}`).join(", ")}` : ""}` : "none"} · worker continuation: ${workerSession ? "yes" : "no"}`,
				"",
				...usageReport(ctx),
				"",
				creditsReport(ctx),
				`Config: ${configPath} (defaults)${userConfigPath ? ` + ${userConfigPath} (personal settings${fs.existsSync(userConfigPath) ? "" : ", not created"})` : ""}`,
			].join("\n"), "info");
		},
	});

	// ── Events ─────────────────────────────────────────────────────────────────────────────────

	pi.on("before_agent_start", async (event, ctx) => {
		if (!enabled) return;
		lastUserPrompt = event.prompt;
		promptSeq++;
		// Unfinished work keeps its supervision, so continuing it does not switch models twice (each switch rereads
		// the whole conversation without prompt cache). Anything else starts conservatively until classified.
		carriedTaskId = carriesOver(openTask()) ? openTask()?.id : undefined;
		if (!carriedTaskId) supervisorFlagshipGrant = undefined;
		supervisorFailoversThisRun = 0;
		await ensureBestSupervisor(ctx, "best available for this prompt");
		applySupervisorEffort();
		updateStatus(ctx);
		if (policyInjected) return;
		policyInjected = true;
		return {
			message: {
				customType: POLICY_TYPE,
				content: "[SUPERVISED CODING]\nGoal: correct, well-made code with as few defects as possible. Quality always beats speed; save tokens only where quality is not affected.\nRoles: you explore, plan, delegate, verify and accept. Workers implement. The extension picks worker models and fails over automatically when a provider runs out of credits; never switch models to hide a coding or test failure.\nWorkflow for every new task:\n1. Read only the files and symbols needed to judge the task, requesting them together in one turn (parallel tool calls); never paste source into handoffs. Everything you read stays in your context and is resent on every later turn: prefer narrow grep patterns and ranged reads (offset/limit) of the relevant symbols to whole files (code_outline gives a large file's declarations with line ranges without reading it, or where a symbol is used), never re-read a range already in context, and read documentation only when the task concerns it. For an audit or analysis spanning many files or large modules, do not read them yourself: call consult_readonly (purpose audit) with the paths and precise questions, then read only the ranges needed to confirm or act on its findings.\n2. Classify assessment.kind, risk, uncertainty and scope using the tool schema. High risk and security/concurrency/migrations have a critical floor; architecture and high uncertainty have a large floor. Choose the profile: small = localized/mechanical; medium = normal multi-file; large = complex architecture or hard debugging; critical = security, concurrency, data migrations or truly exceptional complexity. Choose critical only when a top-tier model is clearly worth it, because it triggers the user's approval for flagship models. When torn between small/medium/large, choose the stronger one. Call plan_task first only for large or critical tasks or when the task needs several delegations; for a single small or medium delegation pass the profile directly to delegate_implementation.\n3. delegate_implementation with a concise task and a structured guide (FILE:, SYMBOLS:, CHANGES:, PRESERVE:, VERIFY:, every allowedPath mentioned). Use effort only when this specific change needs more or less reasoning than its profile. Otherwise use consult_readonly only for concrete uncertainty.\n4. Put the exact test/typecheck/lint commands in VERIFY (e.g. `npm test`, `npx tsc --noEmit`): the extension runs them before and after the change and lets the worker fix regressions itself. Prefer the project's whole test command over the tests of the changed file, unless the suite is slow: a change can break code elsewhere. The delegation result already contains the diff when it is small: review it there and use supervisor_git only for what it does not show; use run_verification for anything VERIFY could not cover.\n5. For corrections or follow-up steps of the same task use continuePrevious=true; do not call plan_task again for the same task.\n6. Call complete_task with accept after reviewing the final diff and checks, before your final response; use pause for unfinished work. Never accept unresolved regressions or MAJOR findings.\n7. When a failure, correction round or review finding reveals a durable repository-specific pitfall, call record_lesson with one concrete instruction; never record task-specific details.\nIf the supervisor model changes after a provider failure, re-check the task state and Git status before continuing and do not redo completed delegations. Final acceptance is your responsibility. Never commit or push unless the user explicitly asks; then use only the confirmation tools. Never merge.",
				display: false,
			},
		};
	});

	pi.on("after_provider_response", (event, ctx) => {
		if (!enabled || !ctx.model) return;
		const reading = readLimitHeaders(event.headers);
		if (!reading) return;
		const key = `pi:${ctx.model.provider}`;
		const previousStatus = health[key]?.status;
		lastLimitHeaders[ctx.model.provider] = reading.raw;
		applyReading(health, key, reading, "response headers", cooldownMs());
		if (health[key]?.status !== previousStatus) persist();
	});

	pi.on("model_select", (event) => {
		// A model picked by the user (not by this extension) pins the supervisor until /SupervisedCoding model auto.
		if (!enabled || settingModel || event.source === "restore" || supervisorMode === "manual") return;
		supervisorMode = "manual";
		persist();
	});

	pi.on("agent_before_settle", async (event, ctx) => {
		if (!enabled || event.outcome !== "error" || !config.supervisorFailover || supervisorRecoveryRunning) return;
		const failure = findLastAssistantError(event.context.contextMessages) ?? findLastAssistantError(ctx.sessionManager.getBranch());
		if (!failure) return;
		const kind = classifyFailure(failure.errorMessage);
		if (!FAILOVER_KINDS.has(kind)) return;
		const provider = failure.provider ?? ctx.model?.provider ?? "unknown";
		const model = failure.model ?? ctx.model?.id ?? "unknown";
		recordSupervisorFailure(provider, model, failure.errorMessage, kind);
		persist();
		if (supervisorFailoversThisRun >= Math.max(1, config.supervisorChain.length)) return;
		const { ranked } = bestSupervisor(ctx);
		for (const { candidate: item } of ranked) {
			if (isCurrent(ctx, item)) continue;
			if (!(await switchSupervisor(ctx, item, `${provider}/${model}: ${kind}`))) continue;
			supervisorFailoversThisRun++;
			metrics.supervisorFailovers++;
			persist();
			updateStatus(ctx);
			return {
				entries: [{
					type: "custom_message",
					customType: "supervisor-failover",
					content: `[SUPERVISOR FAILOVER] The previous supervisor model (${provider}/${model}) stopped because of a provider ${kind} failure: ${failure.errorMessage.slice(0, 300)}\nYou are now ${item.candidate.provider}/${item.candidate.model}. Continue the user's current request from where it stopped. First re-check the current state (TaskPacket phase: ${taskPacket?.phase ?? "none"}; use supervisor_git status/diff-stat) and do not redo completed delegations.`,
					display: true,
				}],
				continue: true,
			};
		}
		// No supervisor model left: fall back to external workers once the run has settled.
		if (config.automaticSupervisorRecovery && lastUserPrompt.trim()) pendingRecoveryTask = lastUserPrompt;
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (!pendingRecoveryTask || supervisorRecoveryRunning) return;
		const task = pendingRecoveryTask;
		pendingRecoveryTask = undefined;
		lastUserPrompt = "";
		await recoverFromSupervisorFailure(ctx, task);
	});

	pi.on("session_compact", () => {
		policyInjected = false;
	});

	pi.on("session_shutdown", () => {
		persist();
	});

	pi.on("session_start", async (_event, ctx) => {
		const branch = ctx.sessionManager.getBranch();
		const saved = branch
			.filter((entry: { type: string; customType?: string }) => entry.type === "custom" && (entry.customType === STATE_TYPE || LEGACY_STATE_TYPES.includes(entry.customType ?? "")))
			.pop() as { data?: PersistedState } | undefined;
		enabled = saved?.data?.enabled ?? false;
		toolsBeforeSupervisor = saved?.data?.toolsBeforeSupervisor;
		const savedMetrics = saved?.data?.metrics;
		metrics = { ...freshMetrics(), ...savedMetrics, byModel: { ...savedMetrics?.byModel }, byRole: { ...savedMetrics?.byRole }, limitStart: { ...savedMetrics?.limitStart }, reviewVerdicts: { ...savedMetrics?.reviewVerdicts } };
		workerSession = saved?.data?.workerSession;
		taskPacket = saved?.data?.taskPacket;
		health = saved?.data?.health ?? {};
		supervisorMode = saved?.data?.supervisorMode ?? (config.supervisorAutoSelect ? "auto" : "manual");
		supervisorFlagshipGrant = saved?.data?.supervisorFlagshipGrant;
		let lastPolicyIndex = -1;
		let lastCompactionIndex = -1;
		branch.forEach((entry: any, index: number) => {
			// Only the current policy counts: sessions from before the rename get the new policy (new tool names) again.
			if (entry.type === "custom_message" && entry.customType === POLICY_TYPE) lastPolicyIndex = index;
			if (entry.type === "compaction") lastCompactionIndex = index;
		});
		policyInjected = lastPolicyIndex > lastCompactionIndex;
		if (enabled && isAllowedSupervisor(ctx, config)) {
			pi.setActiveTools(config.supervisorTools);
			updateStatus(ctx);
		} else {
			enabled = false;
			pi.setActiveTools(pi.getActiveTools().filter((name) => !CUSTOM_TOOLS.has(name)));
		}
	});
}
