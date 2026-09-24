import { execFile as execFileCallback, spawn } from "node:child_process";
import { createHash } from "node:crypto";
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
	lessonsFor,
	loadLearning,
	parseVerdict,
	profileHint,
	profileStats,
	recordOutcome,
	removeLesson,
	saveLearning,
	tuneEfforts,
	type Effort,
	type LearningState,
	type ReviewVerdict,
	type VerificationResult,
} from "./learning.ts";

const execFile = promisify(execFileCallback);
const extensionDir = path.dirname(fileURLToPath(import.meta.url));
/** Overridable so integration tests can run the real extension against fake CLIs and a scratch data directory. */
const configPath = process.env.SUPERVISED_CODING_CONFIG ?? path.join(extensionDir, "config.json");
const learningPath = process.env.SUPERVISED_CODING_DATA ?? path.join(extensionDir, "data", "learning.json");
const EXTENSION_NAME = "SupervisedCoding";
const STATE_TYPE = "supervised-coding";
const POLICY_TYPE = "supervised-coding-policy";
/** Entry types written by the extension before it was renamed; still read so existing sessions keep their state. */
const LEGACY_STATE_TYPES = ["codex-claude-supervisor"];
const CUSTOM_TOOLS = new Set(["plan_task", "consult_readonly", "delegate_implementation", "run_verification", "record_lesson", "supervisor_git", "request_git_commit", "request_git_push"]);
const PROFILE_NAMES = ["small", "medium", "large", "critical"] as const;
const WORKER_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const MAX_STORED_REPORT_CHARS = 8000;
const FLAGSHIP_YES = "SI";
const FLAGSHIP_NO = "No";
/** Shell metacharacters that could chain or redirect commands in run_verification. */
const UNSAFE_COMMAND_CHARS = /[;&|`$<>\r\n%^()]/;

type WorkerEffort = "low" | "medium" | "high" | "xhigh" | "max";
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
type ExecutionProfileName = (typeof PROFILE_NAMES)[number];
/** "api" = a read-only reviewer called directly through a Pi provider (no CLI fixed prompt overhead). */
type WorkerKind = "claude" | "gemini" | "api";

interface WorkerCandidate {
	worker: WorkerKind;
	/** Claude model id, or Gemini model id ("" = Gemini CLI default routing). */
	model: string;
	effort?: WorkerEffort;
	/** Pi provider, for "api" reviewers only. */
	provider?: string;
}

interface SupervisorCandidate {
	provider: string;
	model: string;
}

interface Config {
	workerCommand: string;
	/** Extra leading arguments for workerCommand (e.g. a script path when workerCommand is node). */
	workerCommandArgs: string[];
	geminiCommand: string;
	geminiCommandArgs: string[];
	/** Read-only reviews through a Pi provider API; the Gemini CLI remains the fallback. null disables it. */
	reviewApi: { provider: string; model: string; reasoning: ThinkingLevel } | null;
	/** Run the guide's VERIFY commands before and after each delegation and let the worker fix regressions. */
	autoVerify: boolean;
	maxCorrectionRounds: number;
	/** Repository instruction files given to every worker (they run in --safe-mode and would not load them). */
	repoRulesFiles: string[];
	maxDiffBytes: number;
	learning: { enabled: boolean; autoTuneEffort: boolean };
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
	/** Top-tier models used only for critical tasks and only after the user answers SI. */
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
	minImplementationGuideChars: Record<ExecutionProfileName, number>;
}

interface SupervisorMetrics {
	delegations: number;
	resumedDelegations: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	costUsd: number;
	geminiCalls: number;
	geminiInputTokens: number;
	geminiOutputTokens: number;
	geminiCachedTokens: number;
	geminiFallbacks: number;
	providerFailovers: number;
	supervisorFailovers: number;
	readOnlyConsultations: number;
	claudeAttempts: number;
	gitInspectionBytes: number;
	flagshipRequests: number;
	flagshipApprovals: number;
	verifications: number;
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

interface ModelUsage {
	worker: string;
	model: string;
	runs: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	costUsd: number;
}

interface WorkerSession {
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
	implementationGuide: string;
	acceptanceCriteria: string[];
	allowedPaths: string[];
	phase: TaskPhase;
	primaryWorker?: string;
	lastReport?: string;
	/** Why the supervisor chose this profile (from plan_task). */
	rationale?: string;
	/** User answers to "use flagship model X?" for this task, keyed by model id; asked at most once per task. */
	flagshipDecisions?: Record<string, boolean>;
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
	timedOut: boolean;
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
	geminiCalls: 0,
	geminiInputTokens: 0,
	geminiOutputTokens: 0,
	geminiCachedTokens: 0,
	geminiFallbacks: 0,
	providerFailovers: 0,
	supervisorFailovers: 0,
	readOnlyConsultations: 0,
	claudeAttempts: 0,
	gitInspectionBytes: 0,
	flagshipRequests: 0,
	flagshipApprovals: 0,
	verifications: 0,
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

const DEFAULT_WORKER_CHAINS: Record<ExecutionProfileName, WorkerCandidate[]> = {
	small: [
		{ worker: "claude", model: "claude-sonnet-5", effort: "medium" },
		{ worker: "gemini", model: "" },
		{ worker: "claude", model: "claude-opus-5-5", effort: "low" },
	],
	medium: [
		{ worker: "claude", model: "claude-sonnet-5", effort: "high" },
		{ worker: "claude", model: "claude-opus-5-5", effort: "medium" },
		{ worker: "gemini", model: "" },
	],
	large: [
		{ worker: "claude", model: "claude-opus-5-5", effort: "high" },
		{ worker: "claude", model: "claude-sonnet-5", effort: "xhigh" },
		{ worker: "gemini", model: "" },
	],
	critical: [
		{ worker: "claude", model: "claude-fable-5-1", effort: "xhigh" },
		{ worker: "claude", model: "claude-opus-5-5", effort: "xhigh" },
		{ worker: "gemini", model: "" },
		{ worker: "claude", model: "claude-sonnet-5", effort: "max" },
	],
};

type LegacyConfig = Partial<Config> & {
	workerModel?: string;
	workerEffort?: WorkerEffort;
	geminiModel?: string;
	geminiReviewProfiles?: ExecutionProfileName[];
	geminiImplementationFallback?: boolean;
	executionProfiles?: Partial<Record<ExecutionProfileName, { workerModel: string; workerEffort: WorkerEffort }>>;
	budgetProfiles?: Partial<Record<ExecutionProfileName, { workerModel: string; workerEffort: WorkerEffort }>>;
	defaultBudgetProfile?: ExecutionProfileName;
};

/** Pre-chain configs (executionProfiles + Gemini fallback flag) become single-Claude-plus-Gemini chains. */
function legacyChains(raw: LegacyConfig): Record<ExecutionProfileName, WorkerCandidate[]> | undefined {
	const profiles = raw.executionProfiles ?? raw.budgetProfiles;
	if (!profiles) return undefined;
	const withGemini = raw.geminiImplementationFallback ?? true;
	return Object.fromEntries(PROFILE_NAMES.map((name) => {
		const profile = profiles[name];
		const chain: WorkerCandidate[] = profile ? [{ worker: "claude", model: profile.workerModel, effort: profile.workerEffort }] : [...DEFAULT_WORKER_CHAINS[name]];
		if (profile && withGemini) chain.push({ worker: "gemini", model: raw.geminiModel ?? "" });
		return [name, chain];
	})) as Record<ExecutionProfileName, WorkerCandidate[]>;
}

function loadConfig(): Config {
	const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as LegacyConfig;
	const chainsSource = raw.workerChains ?? legacyChains(raw) ?? DEFAULT_WORKER_CHAINS;
	const workerChains = Object.fromEntries(PROFILE_NAMES.map((name) => [name, chainsSource[name]?.length ? chainsSource[name] : DEFAULT_WORKER_CHAINS[name]])) as Record<ExecutionProfileName, WorkerCandidate[]>;
	for (const [name, chain] of Object.entries(workerChains)) {
		for (const candidate of chain) {
			if (candidate.worker !== "claude" && candidate.worker !== "gemini") throw new Error(`Invalid worker '${String(candidate.worker)}' in workerChains.${name} (${configPath}).`);
			if (candidate.worker === "claude" && !candidate.model) throw new Error(`Claude candidates need a model in workerChains.${name} (${configPath}).`);
		}
	}
	const requestedDefault = raw.defaultExecutionProfile ?? raw.defaultBudgetProfile;
	const rawMinGuide = (raw as { minImplementationGuideChars?: number | Partial<Record<ExecutionProfileName, number>> }).minImplementationGuideChars;
	const guideDefaults: Record<ExecutionProfileName, number> = { small: 150, medium: 400, large: 400, critical: 400 };
	const minImplementationGuideChars = Object.fromEntries(PROFILE_NAMES.map((name) => [name, typeof rawMinGuide === "number" ? rawMinGuide : rawMinGuide?.[name] ?? guideDefaults[name]])) as Record<ExecutionProfileName, number>;
	if (Object.values(minImplementationGuideChars).some((value) => !(value >= 1))) throw new Error(`Invalid implementation guide minimum in ${configPath}.`);
	const flagshipModels = raw.flagshipModels ?? ["claude-fable-5-1", "claude-fable-5", "gpt-6-astra"];
	const flagshipOutsideCritical = PROFILE_NAMES.filter((name) => name !== "critical" && workerChains[name].some((item) => flagshipModels.includes(item.model)));
	if (flagshipOutsideCritical.length) throw new Error(`Flagship models are reserved for the critical profile; remove them from workerChains.${flagshipOutsideCritical.join(", ")} (${configPath}).`);
	const headroom = raw.creditHeadroom ?? 0.9;
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
		geminiCommand: raw.geminiCommand ?? "gemini",
		geminiCommandArgs: raw.geminiCommandArgs ?? [],
		reviewApi: raw.reviewApi === null ? null : { provider: "google", model: "gemini-3.1-pro-preview", reasoning: "high", ...raw.reviewApi },
		autoVerify: raw.autoVerify ?? true,
		maxCorrectionRounds: raw.maxCorrectionRounds ?? 2,
		repoRulesFiles: raw.repoRulesFiles ?? ["AGENTS.md", "CLAUDE.md"],
		maxDiffBytes: raw.maxDiffBytes ?? 60_000,
		learning: { enabled: true, autoTuneEffort: true, ...raw.learning },
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
		independentReviewProfiles: raw.independentReviewProfiles ?? raw.geminiReviewProfiles ?? ["large", "critical"],
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
		supervisorTools: raw.supervisorTools ?? ["read", "grep", "find", "ls", ...CUSTOM_TOOLS],
		maxOutputBytes: raw.maxOutputBytes ?? 51200,
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

function resolveGeminiInvocation(configured: string): { command: string; prefix: string[] } {
	if (configured !== "gemini" || process.platform !== "win32") return { command: configured, prefix: [] };
	const appData = process.env.APPDATA;
	if (appData) {
		const script = path.join(appData, "npm", "node_modules", "@google", "gemini-cli", "bundle", "gemini.js");
		if (fs.existsSync(script)) return { command: process.execPath, prefix: [script] };
	}
	return { command: "gemini", prefix: [] };
}

/** Keep the end of long command output: test runners print failures and summaries last. */
function truncateUtf8Tail(value: string, maxBytes: number): string {
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
	let result = value.slice(-maxBytes);
	while (Buffer.byteLength(result, "utf8") > maxBytes) result = result.slice(1);
	return `[Output truncated; showing the last ${maxBytes} bytes.]\n${result}`;
}

function truncateUtf8(value: string, maxBytes: number): string {
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
	let result = value.slice(0, maxBytes);
	while (Buffer.byteLength(result, "utf8") > maxBytes) result = result.slice(0, -1);
	return `${result}\n\n[Output truncated; inspect the working tree for full details.]`;
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
	const branch = await safeRunGit(cwd, ["branch", "--show-current"]);
	const head = await gitStdout(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"]);
	const unstaged = await gitStdout(cwd, ["diff", "--name-only", "--relative", "-z", "--"]);
	const staged = await gitStdout(cwd, ["diff", "--cached", "--name-only", "--relative", "-z", "--"]);
	const stagedRaw = await gitStdout(cwd, ["diff", "--cached", "--raw", "--no-renames", "--relative", "-z", "--"]);
	const untracked = await gitStdout(cwd, ["ls-files", "--others", "--exclude-standard", "-z", "--"]);
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

/** Instruction files at the working directory and the Git root, capped so they never dominate the prompt. */
function readRepoRules(cwd: string, gitRoot: string | undefined, files: string[], maxBytes = 12_000): string {
	const dirs = [...new Set([cwd, gitRoot].filter((item): item is string => Boolean(item)).map((item) => path.resolve(item)))];
	const parts: string[] = [];
	let total = 0;
	for (const dir of dirs) {
		for (const name of files) {
			const file = path.join(dir, name);
			try {
				if (!fs.statSync(file).isFile()) continue;
				const text = fs.readFileSync(file, "utf8").trim();
				if (!text) continue;
				const remaining = maxBytes - total;
				if (remaining <= 200) break;
				const clipped = truncateUtf8(text, remaining);
				parts.push(`[${path.relative(cwd, file) || name}]\n${clipped}`);
				total += Buffer.byteLength(clipped, "utf8");
			} catch {
				// Missing instruction files are normal.
			}
		}
	}
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

function geminiUsage(stats: Record<string, any> | undefined): { usage?: Usage; model?: string } {
	const models = stats?.models && typeof stats.models === "object" ? Object.entries(stats.models) : [];
	if (!models.length) return {};
	let input = 0;
	let output = 0;
	let cached = 0;
	let reasoning = 0;
	for (const [, data] of models) {
		const tokens = (data as any)?.tokens;
		input += numberField(tokens?.input);
		output += numberField(tokens?.candidates) + numberField(tokens?.thoughts);
		cached += numberField(tokens?.cached);
		reasoning += numberField(tokens?.thoughts);
	}
	return { model: String(models[0][0]), usage: { input, output, cacheRead: cached, cacheWrite: 0, reasoning, totalTokens: input + output + cached, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

function parseJsonObject(value: string): Record<string, any> | undefined {
	try {
		return JSON.parse(value) as Record<string, any>;
	} catch {
		const start = value.indexOf("{");
		const end = value.lastIndexOf("}");
		if (start < 0 || end <= start) return undefined;
		try {
			return JSON.parse(value.slice(start, end + 1)) as Record<string, any>;
		} catch {
			return undefined;
		}
	}
}

function validateImplementationGuide(guide: string, allowedPaths: string[], minChars: number): void {
	const trimmed = guide.trim();
	if (trimmed.length < minChars) {
		throw new Error(`Delegation blocked: implementationGuide is too short (${trimmed.length}/${minChars} chars).`);
	}
	const requiredSections = ["FILE", "SYMBOL", "CHANGE", "PRESERVE", "VERIFY"];
	const missing = requiredSections.filter((section) => !new RegExp(`(^|\\n)\\s*${section}S?\\s*:`, "i").test(trimmed));
	if (missing.length) {
		throw new Error(`Delegation blocked: implementationGuide is missing structured sections: ${missing.join(", ")}. Use FILE, SYMBOLS, CHANGES, PRESERVE, VERIFY.`);
	}
	const absentPaths = allowedPaths.filter((file) => !trimmed.includes(file));
	if (absentPaths.length) {
		throw new Error(`Delegation blocked: every allowed path must appear in the file guide. Missing: ${absentPaths.join(", ")}`);
	}
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
	child.kill("SIGTERM");
	setTimeout(() => {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}, 5000).unref();
}

function runProcess(command: string, args: string[], input: string, cwd: string, signal: AbortSignal | undefined, timeoutMs: number, onLine?: (line: string) => void, options: { shell?: boolean; env?: Record<string, string> } = {}): Promise<ProcessOutcome> {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let buffer = "";
		let aborted = false;
		let timedOut = false;
		let settled = false;
		const child = spawn(command, args, { cwd, shell: options.shell ?? false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...options.env } });
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
				stdout += text;
				return;
			}
			buffer += text;
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) onLine(line);
		});
		child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
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
		}
	});
	if (outcome.aborted) throw new Error("Claude Code worker aborted.");
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
		timedOut: outcome.timedOut,
	};
}

async function runGemini(cwd: string, config: Config, candidate: WorkerCandidate, prompt: string, mode: "plan" | "auto_edit", signal: AbortSignal | undefined, timeoutMs: number): Promise<RunResult> {
	const invocation = resolveGeminiInvocation(config.geminiCommand);
	const args = [...invocation.prefix, ...config.geminiCommandArgs, "--skip-trust", "--approval-mode", mode, "--output-format", "json", "-p", ""];
	if (candidate.model) args.push("--model", candidate.model);
	const outcome = await runProcess(invocation.command, args, prompt, cwd, signal, timeoutMs);
	if (outcome.aborted) throw new Error("Gemini worker aborted.");
	const parsed = parseJsonObject(outcome.stdout);
	const response = typeof parsed?.response === "string" ? parsed.response : "";
	let errorMessage: string | undefined = parsed?.error?.message || (outcome.exitCode !== 0 ? outcome.stderr.trim() || outcome.stdout.trim() || "Gemini CLI failed." : undefined);
	if (outcome.timedOut) errorMessage = `Gemini CLI timed out after ${Math.round(timeoutMs / 60_000)} minutes.${errorMessage ? ` ${errorMessage}` : ""}`;
	const measured = geminiUsage(parsed?.stats);
	const httpStatus = typeof parsed?.error?.code === "number" ? parsed.error.code : undefined;
	return {
		worker: "gemini",
		model: measured.model ?? candidate.model,
		exitCode: outcome.exitCode,
		output: response,
		stderr: outcome.stderr,
		errorMessage,
		turns: response ? 1 : 0,
		sessionId: typeof parsed?.session_id === "string" ? parsed.session_id : undefined,
		costUsd: 0,
		usage: measured.usage,
		signal: { text: `${errorMessage ?? ""}\n${outcome.exitCode !== 0 ? outcome.stderr : ""}`, httpStatus, errorCode: typeof parsed?.error?.status === "string" ? parsed.error.status : undefined },
		timedOut: outcome.timedOut,
	};
}

function runFailed(result: RunResult): boolean {
	return result.exitCode !== 0 || Boolean(result.errorMessage) || result.timedOut;
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
	return `Gemini ${candidate.model || "default"}`;
}

function workerHealthKeys(candidate: WorkerCandidate): string[] {
	if (candidate.worker === "claude") return ["claude-cli", `claude-cli:${claudeFamily(candidate.model)}`, `claude-cli:model:${candidate.model}`];
	// API reviewers share the Pi provider account (and its credits) with the supervisor.
	if (candidate.worker === "api") return [`pi:${candidate.provider}`, `pi:model:${candidate.provider}/${candidate.model}`];
	return ["gemini-cli", `gemini-cli:model:${candidate.model || "default"}`];
}

const SKIPPED_DIRS = new Set([".git", "node_modules", "dist", "build", "out", "coverage", ".venv", "__pycache__", "target", ".next"]);

/**
 * Text of the given paths for an API reviewer (directories expanded two levels, generated folders skipped).
 * Returns undefined when the material exceeds maxBytes: the CLI reviewer, which can browse, is used instead.
 */
function collectFiles(cwd: string, paths: string[], maxBytes: number): string | undefined {
	const parts: string[] = [];
	let total = 0;
	const visit = (relative: string, depth: number): boolean => {
		const absolute = path.join(cwd, relative);
		let stat: fs.Stats;
		try {
			stat = fs.statSync(absolute);
		} catch {
			return true; // Deleted or not yet created: the diff shows it.
		}
		if (stat.isDirectory()) {
			if (depth > 2) return true;
			for (const entry of fs.readdirSync(absolute)) {
				if (SKIPPED_DIRS.has(entry)) continue;
				if (!visit(path.join(relative, entry), depth + 1)) return false;
			}
			return true;
		}
		if (!stat.isFile()) return true;
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

/** Read-only review through a Pi provider: only the diff and files are sent, without a CLI's fixed prompt overhead. */
async function runApiReview(ctx: ExtensionContext, candidate: WorkerCandidate, reasoning: ThinkingLevel, prompt: string, material: string, signal: AbortSignal | undefined, timeoutMs: number): Promise<RunResult> {
	const base = { worker: "api" as const, model: candidate.model, stderr: "", turns: 1, timedOut: false };
	const model = ctx.modelRegistry.find(candidate.provider ?? "", candidate.model);
	if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) {
		const errorMessage = `model not available in Pi: ${candidate.provider}/${candidate.model}`;
		return { ...base, exitCode: 1, output: "", errorMessage, costUsd: 0, signal: { text: errorMessage, httpStatus: 404 } };
	}
	const controller = new AbortController();
	const onAbort = () => controller.abort();
	signal?.addEventListener("abort", onAbort, { once: true });
	let timedOut = false;
	const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs) : undefined;
	try {
		const content = `${prompt}\n\nFILES (current content)\n${material || "(none)"}`;
		const message = await ctx.modelRegistry.streamSimple(model, { messages: [{ role: "user", content, timestamp: Date.now() }] }, { reasoning: reasoning === "off" ? undefined : reasoning, signal: controller.signal }).result();
		if (signal?.aborted) throw new Error("API review aborted.");
		const output = message.content.filter((part): part is { type: "text"; text: string } => part.type === "text").map((part) => part.text).join("\n").trim();
		const errorMessage = message.stopReason === "error" || message.stopReason === "aborted" ? message.errorMessage ?? (timedOut ? `API review timed out after ${Math.round(timeoutMs / 60_000)} minutes.` : "API review failed.") : undefined;
		return { ...base, exitCode: errorMessage ? 1 : 0, output, errorMessage, costUsd: numberField(message.usage?.cost?.total), usage: message.usage, signal: { text: errorMessage ?? "" }, timedOut, turns: output ? 1 : 0 };
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
}

interface ImplementationSpec {
	task: string;
	guide: string;
	criteria: string[];
	allowedPaths: string[];
	profileName: ExecutionProfileName;
	preferWorker?: WorkerKind;
	/** Supervisor override of the profile's Claude effort for this delegation. */
	effort?: WorkerEffort;
	resumeSessionId?: string;
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

function orderChain(chain: WorkerCandidate[], prefer?: WorkerKind): WorkerCandidate[] {
	if (!prefer) return chain;
	return [...chain.filter((item) => item.worker === prefer), ...chain.filter((item) => item.worker !== prefer)];
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
	const lastLimitHeaders: Record<string, Record<string, string>> = {};
	// Learning is global (across sessions and projects), stored next to the extension, never in the session log.
	let learning: LearningState = loadLearning(learningPath);
	const gitRoots = new Map<string, string | undefined>();

	function saveLearningSafe(ctx?: ExtensionContext): void {
		try {
			saveLearning(learningPath, learning);
		} catch (error) {
			ctx?.ui.notify(`${EXTENSION_NAME}: could not save learning data (${error instanceof Error ? error.message : String(error)}).`, "warning");
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

	async function repoContextFor(cwd: string): Promise<string> {
		const rules = readRepoRules(cwd, await gitRoot(cwd), config.repoRulesFiles);
		const lessons = config.learning.enabled ? lessonsFor(learning, await repoKey(cwd)).map((item) => item.text) : [];
		return buildRepoContext(rules, lessons);
	}

	const cooldownMs = () => config.exhaustedCooldownMinutes * 60_000;
	const minutes = (value: number) => (value > 0 ? value * 60_000 : 0);

	function statusText(ctx: ExtensionContext): string {
		const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no model";
		const task = openTask() ? ` · ${taskPacket?.profile}` : "";
		return `${EXTENSION_NAME} ${model}/${pi.getThinkingLevel()}${supervisorMode === "auto" ? " (auto)" : ""}${task} · C${metrics.claudeAttempts} G${metrics.geminiCalls} · ${metrics.providerFailovers + metrics.supervisorFailovers} failovers`;
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
		const answer = await ctx.ui.select(`Sarebbe più utile utilizzare ${name} per questa task. Vuoi utilizzarlo?`, [FLAGSHIP_YES, FLAGSHIP_NO]);
		const approved = answer === FLAGSHIP_YES;
		if (approved) metrics.flagshipApprovals++;
		if (openTask() && taskPacket) taskPacket = { ...taskPacket, flagshipDecisions: { ...taskPacket.flagshipDecisions, [model]: approved }, updatedAt: Date.now() };
		persist();
		return approved;
	}

	/** Supervisor reasoning effort follows the open task's profile; without a task it drops back to the default. */
	function applySupervisorEffort(profile?: ExecutionProfileName): void {
		const level = config.supervisorEffort[profile ?? openTask()?.profile ?? "default"] ?? config.supervisorEffort.default;
		if (pi.getThinkingLevel() !== level) pi.setThinkingLevel(level);
	}

	function recordRun(result: RunResult, role: UsageRole): void {
		const usage = result.usage;
		const key = `${result.worker}:${result.model || "default"}`;
		const entry = (metrics.byModel[key] ??= { worker: result.worker, model: result.model || "default", runs: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 });
		entry.runs++;
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
			metrics.apiReviews++;
			metrics.apiTokens += result.usage?.totalTokens ?? 0;
			metrics.apiCostUsd += result.costUsd;
		} else {
			metrics.geminiCalls++;
			metrics.geminiInputTokens += result.usage?.input ?? 0;
			metrics.geminiOutputTokens += result.usage?.output ?? 0;
			metrics.geminiCachedTokens += result.usage?.cacheRead ?? 0;
		}
	}

	/** Update provider health from a finished worker run: limit readings on success, exhaustion markers on provider failures. */
	function recordWorkerHealth(candidate: WorkerCandidate, result: RunResult, kind: FailureKind | undefined): void {
		const now = Date.now();
		const source = `${candidateLabel(candidate)} run`;
		const providerKey = candidate.worker === "claude" ? "claude-cli" : candidate.worker === "api" ? `pi:${candidate.provider}` : "gemini-cli";
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
	}

	/** One allowlisted check, non-interactive (CI=1 keeps test runners out of watch mode). */
	async function runCheck(ctx: ExtensionContext, command: string, signal: AbortSignal | undefined): Promise<CheckResult> {
		const before = await getGitSnapshot(ctx.cwd);
		const outcome = await runProcess(command, [], "", ctx.cwd, signal, minutes(config.verificationTimeoutMinutes), undefined, { shell: true, env: { CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" } });
		if (outcome.aborted) throw new Error("Verification aborted.");
		const after = await getGitSnapshot(ctx.cwd);
		metrics.verifications++;
		return {
			command,
			ok: outcome.exitCode === 0 && !outcome.timedOut,
			exitCode: outcome.exitCode,
			timedOut: outcome.timedOut,
			output: `${outcome.stdout}${outcome.stderr ? `\n[stderr]\n${outcome.stderr}` : ""}`.trim() || "(no output)",
			changed: filesChangedBetween(before, after),
		};
	}

	async function runChecks(ctx: ExtensionContext, commands: string[], signal: AbortSignal | undefined): Promise<CheckResult[]> {
		const results: CheckResult[] = [];
		for (const command of commands) results.push(await runCheck(ctx, command, signal));
		return results;
	}

	function formatChecks(checks: CheckResult[], baseline: Map<string, boolean>, rounds: number, verification: VerificationResult, notes: string[]): string {
		const lines = checks.map((check) => {
			const state = check.ok ? "pass" : baseline.get(check.command) === false ? "FAIL (was already failing before the change)" : "FAIL (regression)";
			return `- ${check.command}: ${state}`;
		});
		const failing = checks.filter((check) => !check.ok).map((check) => `$ ${check.command}\n${check.timedOut ? "timed out" : `exit code ${check.exitCode}`}\n${truncateUtf8Tail(check.output, 4000)}`);
		return [
			`AUTOMATIC VERIFICATION: ${verification.toUpperCase()}${rounds ? ` (${rounds} correction round${rounds > 1 ? "s" : ""})` : ""}`,
			...lines,
			...notes,
			...(failing.length ? ["", ...failing] : []),
		].join("\n");
	}

	/** Let the implementer fix its own regressions: resume its Claude session, or re-run with the diff and failures. */
	async function runCorrection(ctx: ExtensionContext, implementer: WorkerCandidate, sessionId: string | undefined, spec: ImplementationSpec, failing: CheckResult[], round: number, signal: AbortSignal | undefined): Promise<{ result: RunResult; kind?: FailureKind }> {
		const failures = failing.map((check) => `$ ${check.command}\n${check.timedOut ? "timed out" : `exit code ${check.exitCode}`}\n${truncateUtf8Tail(check.output, 6000)}`).join("\n\n");
		const instructions = `[CORRECTION ROUND ${round}] These checks passed before your change and fail now:\n\n${failures}\n\nFind and fix the cause in the allowlisted files. Never weaken, skip or delete tests and do not change the checks themselves. If the cause is outside the allowlist or the requirement is ambiguous, stop and explain. Return the changed files and what you fixed.`;
		let result: RunResult | undefined;
		let kind: FailureKind | undefined;
		for (let attempt = 0; attempt <= config.transientRetryAttempts; attempt++) {
			if (implementer.worker === "claude" && sessionId) {
				result = await runClaude(ctx.cwd, config, implementer, "edit", instructions, sessionId, signal, minutes(config.workerTimeoutMinutes));
			} else {
				const diff = await scopedDiff(ctx.cwd, spec.allowedPaths, config.maxDiffBytes);
				const prompt = `${buildWorkerPrompt(spec.task, spec.guide, spec.criteria, spec.allowedPaths, false, spec.repoContext)}\n\nCURRENT CHANGES (made by the previous attempt)\n${diff}\n\n${instructions}`;
				result = implementer.worker === "claude"
					? await runClaude(ctx.cwd, config, implementer, "edit", prompt, undefined, signal, minutes(config.workerTimeoutMinutes))
					: await runGemini(ctx.cwd, config, implementer, prompt, "auto_edit", signal, minutes(config.workerTimeoutMinutes));
			}
			recordRun(result, "correct");
			kind = runFailed(result) ? failureKindOf(result) : undefined;
			if (kind !== "transient" || attempt >= config.transientRetryAttempts) break;
			await waitForRetry(config.transientRetryDelayMs * 2 ** attempt, signal);
		}
		const finalResult = result as RunResult;
		recordWorkerHealth(implementer, finalResult, kind);
		return { result: finalResult, kind };
	}

	/** What learning knows about this repository, for the supervisor at planning time. */
	async function learningBriefing(ctx: ExtensionContext, profile: ExecutionProfileName): Promise<string[]> {
		if (!config.learning.enabled) return [];
		const repo = await repoKey(ctx.cwd);
		const lines: string[] = [];
		const hint = profileHint(profileStats(learning, repo), profile);
		if (hint) lines.push(`Learning: ${hint}`);
		const adjusted = config.workerChains[profile]
			.filter((item) => item.worker === "claude" && item.effort)
			.map((item) => ({ item, effort: effectiveEffort(learning, profile, item.model, item.effort as Effort) }))
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

		// Workers and reviewers; the Gemini CLI reports no cost, so it is estimated from Pi's price list.
		const estimate = (item: ModelUsage): { cost: number; estimated: boolean } => {
			if (item.costUsd > 0 || item.worker !== "gemini") return { cost: item.costUsd, estimated: false };
			const price = ctx.modelRegistry.find("google", item.model)?.cost;
			if (!price) return { cost: 0, estimated: true };
			return { cost: (item.input * price.input + item.output * price.output + item.cacheRead * price.cacheRead) / 1_000_000, estimated: true };
		};
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
			const label = item.worker === "claude" ? `Claude ${item.model}` : item.worker === "api" ? `API ${item.model}` : `Gemini CLI ${item.model}`;
			const { cost, estimated } = estimate(item);
			lines.push(row(label, `${item.runs} run${item.runs === 1 ? "" : "s"}`, item, money(cost, estimated)));
		}
		lines.push(`  Total: ${fmt(grand)} tokens · ${money(supervisorCost + workerCost)} (supervisor ${pct(supervisorTotal)}, workers/reviewers ${pct(workerTotal)})`);

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
		lines.push(`Subscription limits used in this conversation: ${deltas.length ? deltas.join(" · ") : "no readings yet (/SupervisedCoding credits refresh)"}`);

		const verdicts = Object.entries(metrics.reviewVerdicts).map(([verdict, count]) => `${verdict.toUpperCase()} ${count}`).join(", ");
		const completed = metrics.delegations - metrics.failedDelegations;
		lines.push(`Quality: ${metrics.delegations} delegations (${completed} completed, ${metrics.failedDelegations} failed) · ${metrics.autoVerifiedDelegations} auto-verified, ${metrics.firstPassDelegations} green at the first attempt, ${metrics.correctionRounds} correction rounds · reviews: ${verdicts || "none"}`);
		lines.push(`Routing: failovers workers ${metrics.providerFailovers}, supervisor ${metrics.supervisorFailovers} · flagship asked ${metrics.flagshipRequests} (${metrics.flagshipApprovals} approved) · consultations ${metrics.readOnlyConsultations} · resumed sessions ${metrics.resumedDelegations} · checks run ${metrics.verifications}`);
		if (completed > 0) lines.push(`Average per completed delegation: ${fmt(Math.round(grand / completed))} tokens · ${money((supervisorCost + workerCost) / completed)}`);
		lines.push("Costs are API-equivalent: on subscriptions (Claude Code, Codex) the real cost is the plan usage shown above; ~ = estimated from Pi's price list.");
		return lines;
	}

	/** Every Claude candidate with a configured effort is a calibration target. */
	function tuningTargets(): Array<{ profile: string; model: string; configured: Effort }> {
		return PROFILE_NAMES.flatMap((profile) => config.workerChains[profile]
			.filter((item) => item.worker === "claude" && item.effort)
			.map((item) => ({ profile, model: item.model, configured: item.effort as Effort })));
	}

	/**
	 * Record the outcome of a delegation and recalibrate effort. Delegations that never reached a worker for
	 * provider reasons carry no quality signal and are not recorded.
	 */
	async function learnFromDelegation(ctx: ExtensionContext, data: { implementer: WorkerCandidate; final: RunResult; profileName: ExecutionProfileName; verification: VerificationResult; correctionRounds: number; reviewVerdict: ReviewVerdict; failed: boolean; combined?: Usage }): Promise<string[]> {
		if (!config.learning.enabled) return [];
		if (runFailed(data.final) && FAILOVER_KINDS.has(failureKindOf(data.final))) return [];
		recordOutcome(learning, {
			at: Date.now(),
			repo: await repoKey(ctx.cwd),
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
		const changes = config.learning.autoTuneEffort ? tuneEfforts(learning, tuningTargets()) : [];
		saveLearningSafe(ctx);
		if (changes.length) ctx.ui.notify(`${EXTENSION_NAME} learned: ${changes.join("; ")}`, "info");
		return changes;
	}

	/**
	 * Run the profile's worker chain: best healthy candidate first, retry transient failures, move to the next
	 * candidate on credit/auth/availability failures with a handoff note, and stop on genuine task failures.
	 */
	async function executeImplementation(ctx: ExtensionContext, spec: ImplementationSpec, signal: AbortSignal | undefined, onProgress?: (text: string, label: string) => void): Promise<ImplementationOutcome> {
		const chain = orderChain(config.workerChains[spec.profileName], spec.preferWorker);
		const { usable, blocked } = rankCandidates(chain, workerHealthKeys, health, config.creditHeadroom);
		if (!usable.length) throw new Error(`No worker available for profile ${spec.profileName}: all candidates are out of credits or unavailable (${describeBlocked(blocked)}). Use /SupervisedCoding credits refresh after a reset, or /SupervisedCoding credits reset to retry anyway.`);
		const before = await getGitSnapshot(ctx.cwd);
		const attempts: AttemptRecord[] = blocked.map((item) => ({ label: candidateLabel(item.candidate), ok: false, kind: "credits" as FailureKind, detail: `skipped: exhausted until ${formatUntil(item.until)}` }));
		const usage: Array<Usage | undefined> = [];
		let final: RunResult | undefined;
		let finalCandidate: WorkerCandidate | undefined;
		let handoff = "";
		let resumed = false;
		let claudeResumeAvailable = Boolean(spec.resumeSessionId);
		let providerFailureSeen = false;
		for (const { candidate: configured } of usable) {
			// Effort: the supervisor's explicit override, else what learning calibrated for this profile/model, else config.json.
			const learnedEffort = config.learning.enabled ? effectiveEffort(learning, spec.profileName, configured.model, configured.effort as Effort | undefined) : configured.effort;
			const candidate: WorkerCandidate = configured.worker === "claude" ? { ...configured, effort: resolveEffort(spec.effort, learnedEffort, spec.profileName) } : configured;
			const label = candidateLabel(candidate);
			if (isFlagship(candidate.model) && !(await approveFlagship(ctx, candidate.model, modelDisplayName(ctx, candidate.worker === "claude" ? "anthropic" : "google", candidate.model)))) {
				attempts.push({ label, ok: false, detail: "declined: flagship not authorized" });
				continue;
			}
			const resumeId = candidate.worker === "claude" && claudeResumeAvailable ? spec.resumeSessionId : undefined;
			const basePrompt = buildWorkerPrompt(spec.task, spec.guide, spec.criteria, spec.allowedPaths, Boolean(resumeId), spec.repoContext);
			let result: RunResult | undefined;
			let kind: FailureKind | undefined;
			for (let attempt = 0; attempt <= config.transientRetryAttempts; attempt++) {
				if (candidate.worker === "claude") {
					result = await runClaude(ctx.cwd, config, candidate, "edit", `${handoff ? `${handoff}\n\n` : ""}${basePrompt}`, resumeId, signal, minutes(config.workerTimeoutMinutes), (text) => onProgress?.(text, label));
				} else {
					const geminiPrompt = `${handoff ? `${handoff}\n\n` : ""}${basePrompt}\n\n[GEMINI WORKER NOTES]\nEdit only the allowlisted paths and preserve pre-existing changes. Never stage, commit, push, merge, change branches, or rewrite Git history. If shell tools are unavailable in this mode, do not claim checks passed: list the exact verification commands the supervisor must run.`;
					result = await runGemini(ctx.cwd, config, candidate, geminiPrompt, "auto_edit", signal, minutes(config.workerTimeoutMinutes));
				}
				recordRun(result, "implement");
				usage.push(result.usage);
				kind = runFailed(result) ? failureKindOf(result) : undefined;
				if (kind !== "transient" || attempt >= config.transientRetryAttempts) break;
				await waitForRetry(config.transientRetryDelayMs * 2 ** attempt, signal);
			}
			if (!result) continue;
			if (resumeId) {
				resumed = true;
				claudeResumeAvailable = false;
			}
			recordWorkerHealth(candidate, result, kind);
			final = result;
			finalCandidate = candidate;
			attempts.push({ label, ok: !kind, kind, detail: kind ? (result.errorMessage || result.stderr).trim().slice(0, 300) : undefined });
			if (!kind) break;
			// Coding/test/context failures must be diagnosed by the supervisor, never hidden by switching models.
			if (!FAILOVER_KINDS.has(kind) && kind !== "transient") break;
			providerFailureSeen = true;
			metrics.providerFailovers++;
			const now = await getGitSnapshot(ctx.cwd);
			const partial = filesChangedBetween(before, now).filter((file) => pathInAllowedScope(file, spec.allowedPaths));
			handoff = handoffNote(label, kind, partial, partial.length ? await scopedDiff(ctx.cwd, partial, config.maxDiffBytes) : "");
		}
		if (!final || !finalCandidate) throw new Error(`No worker could be started for profile ${spec.profileName}: ${attempts.map((item) => `${item.label} (${item.detail ?? item.kind})`).join("; ") || "empty chain"}.`);
		if (providerFailureSeen && finalCandidate.worker === "gemini") metrics.geminiFallbacks++;
		const failed = runFailed(final);
		const after = await getGitSnapshot(ctx.cwd);
		const scopeViolations = compareGitSnapshots(before, after, spec.allowedPaths);
		const chainLine = attempts.length > 1 ? `Worker chain: ${attempts.map((item) => `${item.label} ${item.ok ? "✓" : `✗ ${item.kind ?? ""}${item.detail?.startsWith("skipped") ? " (skipped)" : item.detail?.startsWith("declined") ? "declined by user" : ""}`}`).join(" → ")}\n\n` : "";
		let primaryOutput = `${chainLine}${final.output || final.errorMessage || final.stderr || "The worker returned no output."}`;
		if (scopeViolations.length) primaryOutput += `\n\nSCOPE/GIT SAFETY VIOLATION: ${scopeViolations.join("; ")}. Review and correct manually; no automatic revert was attempted.`;
		return { failed: failed || scopeViolations.length > 0, final, finalCandidate, primaryOutput, attempts, usage, before, after, scopeViolations, resumed };
	}

	/** Read-only consultation with failover across reviewers; any working-tree mutation is reported as a violation. */
	async function runConsultation(ctx: ExtensionContext, order: WorkerCandidate[], header: string, question: string, paths: string[], signal: AbortSignal | undefined, options: { diff?: string; requireVerdict?: boolean; role?: UsageRole } = {}): Promise<ConsultOutcome> {
		const { usable, blocked } = rankCandidates(order, workerHealthKeys, health, config.creditHeadroom);
		const attempts: AttemptRecord[] = blocked.map((item) => ({ label: candidateLabel(item.candidate), ok: false, kind: "credits" as FailureKind, detail: "skipped: exhausted" }));
		const usage: Array<Usage | undefined> = [];
		const before = await getGitSnapshot(ctx.cwd);
		let text = usable.length ? "" : `No read-only reviewer available (${describeBlocked(blocked)}).`;
		let reviewer: string | undefined;
		let failed = true;
		const pathList = paths.map((item) => `- ${item}`).join("\n");
		const diffBlock = options.diff ? `\n\nCHANGES UNDER REVIEW (diff against HEAD)\n\`\`\`diff\n${options.diff}\n\`\`\`\nBase the review on these changes; read files only for the surrounding context you need.` : "";
		const verdictLine = options.requireVerdict ? "\nEnd with exactly one final line: VERDICT: PASS (no material defect) | MINOR (only minor issues) | MAJOR (bugs, missed requirements, regressions or unsafe behavior)." : "";
		let material: string | undefined | null = null;
		for (const { candidate } of usable) {
			const label = candidateLabel(candidate);
			const prompt = `${header}\n${question}\nRelevant paths:\n${pathList}${diffBlock}\n\nInspect only the listed paths and directly relevant symbols. Do not edit, write, stage, commit, push, merge, switch branches, or run mutating commands. Return concise findings ordered by severity, concrete evidence with file/symbol references, recommended action, verification ideas, and remaining uncertainty. Do not summarize unrelated code.${verdictLine}`;
			if (candidate.worker === "api") {
				// An API reviewer cannot browse: it needs the files inline, and only when they fit.
				if (material === null) material = collectFiles(ctx.cwd, paths, 250_000);
				if (material === undefined) {
					attempts.push({ label, ok: false, detail: "skipped: files too large for an API review" });
					continue;
				}
			}
			let result: RunResult | undefined;
			let kind: FailureKind | undefined;
			for (let attempt = 0; attempt <= config.transientRetryAttempts; attempt++) {
				result = candidate.worker === "claude"
					? await runClaude(ctx.cwd, config, candidate, "readonly", prompt, undefined, signal, minutes(config.consultTimeoutMinutes))
					: candidate.worker === "api"
						? await runApiReview(ctx, candidate, config.reviewApi?.reasoning ?? "high", prompt, material ?? "", signal, minutes(config.consultTimeoutMinutes))
						: await runGemini(ctx.cwd, config, candidate, prompt, "plan", signal, minutes(config.consultTimeoutMinutes));
				recordRun(result, options.role ?? "consult");
				usage.push(result.usage);
				kind = runFailed(result) ? failureKindOf(result) : undefined;
				if (kind !== "transient" || attempt >= config.transientRetryAttempts) break;
				await waitForRetry(config.transientRetryDelayMs * 2 ** attempt, signal);
			}
			if (!result) continue;
			recordWorkerHealth(candidate, result, kind);
			attempts.push({ label, ok: !kind, kind, detail: kind ? (result.errorMessage || result.stderr).trim().slice(0, 300) : undefined });
			text = result.output || result.errorMessage || result.stderr || "The reviewer returned no output.";
			reviewer = label;
			failed = Boolean(kind);
			if (!kind || (!FAILOVER_KINDS.has(kind) && kind !== "transient")) break;
			metrics.providerFailovers++;
		}
		const after = await getGitSnapshot(ctx.cwd);
		const violations = compareGitSnapshots(before, after, []);
		return { failed: failed || violations.length > 0, text, reviewer, attempts, usage, violations, gitAvailable: before.available && after.available, verdict: failed ? "none" : parseVerdict(text) };
	}

	/** Non-flagship reviewers of one family, strongest profile chains first, one entry per model. Flagships are for implementation only. */
	function reviewers(worker: WorkerKind, profiles: ExecutionProfileName[]): WorkerCandidate[] {
		const seen = new Set<string>();
		const result: WorkerCandidate[] = [];
		for (const profile of profiles) {
			for (const item of config.workerChains[profile]) {
				if (item.worker !== worker || isFlagship(item.model) || seen.has(item.model)) continue;
				seen.add(item.model);
				result.push(item);
			}
		}
		if (worker === "claude") return result;
		const cli: WorkerCandidate[] = result.length ? result : [{ worker: "gemini", model: "" }];
		// Same model family through the API first (no CLI fixed overhead); the CLI stays as fallback and for large inputs.
		return config.reviewApi ? [{ worker: "api", provider: config.reviewApi.provider, model: config.reviewApi.model }, ...cli] : cli;
	}

	/**
	 * Independent review. large: Claude read-only, a different model first (cheap, no Gemini fixed overhead).
	 * critical: a different model family first, because cross-family review catches different mistakes.
	 */
	function reviewOrder(implementer: WorkerCandidate, profile: ExecutionProfileName): WorkerCandidate[] {
		const claude = reviewers("claude", [profile, "large", "critical"]);
		const claudeOrdered = [...claude.filter((item) => item.model !== implementer.model), ...claude.filter((item) => item.model === implementer.model)];
		const gemini = reviewers("gemini", [profile, "large", "critical"]);
		if (implementer.worker === "gemini") return [...claudeOrdered, ...gemini];
		return profile === "critical" ? [...gemini, ...claudeOrdered] : [...claudeOrdered, ...gemini];
	}

	function consultOrder(reviewer: "auto" | WorkerKind, profileName: ExecutionProfileName): WorkerCandidate[] {
		const claude = reviewers("claude", [profileName, "large"]);
		const gemini = reviewers("gemini", [profileName, "large"]);
		return reviewer === "gemini" ? [...gemini, ...claude] : [...claude, ...gemini];
	}

	// ── Supervisor (Pi model) selection ────────────────────────────────────────────────────────────

	interface ResolvedSupervisor {
		candidate: SupervisorCandidate;
		model: Model<any>;
	}

	function resolveSupervisors(ctx: ExtensionContext): { resolved: ResolvedSupervisor[]; skipped: string[] } {
		const resolved: ResolvedSupervisor[] = [];
		const skipped: string[] = [];
		for (const candidate of config.supervisorChain) {
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
		return Boolean(grant && openTask()?.id === grant.taskId && grant.provider === candidate.provider && grant.model === candidate.model);
	}

	function bestSupervisor(ctx: ExtensionContext): { best?: ResolvedSupervisor; ranked: RankedCandidate<ResolvedSupervisor>[]; blocked: RankedCandidate<ResolvedSupervisor>[] } {
		const eligible = resolveSupervisors(ctx).resolved.filter((item) => !isFlagship(item.candidate.model) || flagshipGranted(item.candidate));
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
				onResponse: (response: { headers: Record<string, string> }) => { headers = response.headers; },
			} as any);
			if (headers) {
				const reading = readLimitHeaders(headers);
				if (reading) {
					lastLimitHeaders[item.candidate.provider] = reading.raw;
					applyReading(health, `pi:${item.candidate.provider}`, reading, "probe", cooldownMs());
				}
			}
			if (message.stopReason === "error") {
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

	async function refreshCredits(ctx: ExtensionContext): Promise<string[]> {
		const lines = [await probeClaude(ctx)];
		for (const item of resolveSupervisors(ctx).resolved) lines.push(await probeSupervisor(ctx, item));
		lines.push("Gemini CLI: no quota API; tracked reactively from errors.");
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
			const guide = `FILE: ${allowedPaths.join(", ")}\nSYMBOLS: all symbols directly relevant to the task and the current working-tree diff\nCHANGES:\n- Inspect repository instructions, the current Git diff and the task below.\n- Finish or fix the implementation; keep changes minimal and complete.\nPRESERVE:\n- Pre-existing user changes, behavior outside task scope, Git history.\n- Never stage, commit, push, merge, or change branches.\nVERIFY:\n- Run the relevant tests/typecheck/lint and report exact outcomes.\n\nPREVIOUS GUIDE:\n${taskPacket.implementationGuide}`;
			const outcome = await executeImplementation(ctx, { task: `${taskPacket.objective}\n\nUser request that the supervisor could not finish: ${task}`, guide, criteria: taskPacket.acceptanceCriteria, allowedPaths, profileName: "critical", repoContext: await repoContextFor(ctx.cwd) }, ctx.signal);
			let report = `External recovery by ${outcome.finalCandidate ? candidateLabel(outcome.finalCandidate) : "no worker"} ${outcome.failed ? "failed" : "completed"}:\n${outcome.primaryOutput}`;
			const usage = [...outcome.usage];
			if (!outcome.failed && outcome.finalCandidate) {
				const review = await runConsultation(ctx, reviewOrder(outcome.finalCandidate, "critical"), "[INDEPENDENT READ-ONLY CODE REVIEW]", `Task: ${taskPacket.objective}\nLook for correctness bugs, missed requirements and regressions.`, allowedPaths, ctx.signal, { diff: await scopedDiff(ctx.cwd, allowedPaths, config.maxDiffBytes), requireVerdict: true, role: "review" });
				usage.push(...review.usage);
				report += `\n\nIndependent review (${review.reviewer ?? "unavailable"}):\n${review.text}`;
			}
			updateTaskPacket({ phase: outcome.failed ? "failed" : "implemented", primaryWorker: outcome.finalCandidate ? candidateLabel(outcome.finalCandidate) : undefined, lastReport: report });
			pi.sendMessage({ customType: "supervisor-provider-recovery", content: truncateUtf8(report, config.maxOutputBytes), display: true, details: { usage: combineUsage(usage) } });
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
		description: "Call once at the start of every new coding task, after the minimum exploration needed to judge it and before any delegation. Records the task and its complexity profile, sets your own reasoning effort for that profile, and for critical tasks asks the user whether a flagship supervisor model should be used. Do not call it again for corrections or follow-ups of the same task.",
		parameters: Type.Object({
			task: Type.String({ description: "One-sentence objective of the whole task" }),
			profile: StringEnum(PROFILE_NAMES, { description: "small = localized or mechanical change; medium = normal multi-file work; large = complex architecture or hard debugging; critical = security, concurrency, data migrations, or exceptionally complex work where a top-tier model is clearly worth it. If torn between two, choose the stronger one." }),
			rationale: Type.String({ description: "Concrete reasons for the profile: risk, scope, uncertainty" }),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			if (!enabled) throw new Error("SupervisedCoding is disabled. Run /SupervisedCoding on.");
			if (!isAllowedSupervisor(ctx, config)) throw new Error("Only an active supervisor model may plan tasks.");
			taskPacket = {
				id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				objective: params.task,
				profile: params.profile,
				rationale: params.rationale,
				implementationGuide: "",
				acceptanceCriteria: [],
				allowedPaths: [],
				phase: "planned",
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
		name: "consult_readonly",
		label: "Read-only consultation",
		description: "Independent read-only coding analysis. Claude read-only (no Edit/Write/Bash) is cheaper; Gemini gives a different model family but has a large fixed prompt overhead. Unavailable/out-of-credit reviewers are skipped automatically. Use for architecture, risk, test strategy, hard debugging, or implementation review — not routine summaries.",
		parameters: Type.Object({
			purpose: StringEnum(["architecture", "risk-review", "test-strategy", "debugging", "implementation-review"] as const),
			question: Type.String({ description: "Narrow, decision-oriented question. Include known evidence; do not ask for a generic repository summary." }),
			paths: Type.Array(Type.String({ description: "Repository-relative paths to inspect" }), { minItems: 1 }),
			reviewer: Type.Optional(StringEnum(["auto", "claude", "gemini"] as const, { description: "Preferred reviewer family; the other family is used if it is out of credits. Default auto (Claude first)." })),
			profile: Type.Optional(StringEnum(PROFILE_NAMES, { description: "Model/effort chain for Claude reviewers; stronger for higher risk." })),
		}),
		async execute(_id, params, signal, _update, ctx) {
			if (!enabled) throw new Error("SupervisedCoding is disabled. Run /SupervisedCoding on.");
			if (!isAllowedSupervisor(ctx, config)) throw new Error("Only an active supervisor model may request consultations.");
			const paths = normalizeAllowedPaths(params.paths, false);
			const profileName = params.profile ?? (params.purpose === "architecture" || params.purpose === "risk-review" ? "large" : "medium");
			const outcome = await runConsultation(ctx, consultOrder(params.reviewer ?? "auto", profileName), `[READ-ONLY CODING CONSULTANT]\nPurpose: ${params.purpose}`, `Question: ${params.question}`, paths, signal);
			metrics.readOnlyConsultations++;
			persist();
			updateStatus(ctx);
			const chain = outcome.attempts.length > 1 ? `\nReviewer chain: ${outcome.attempts.map((item) => `${item.label} ${item.ok ? "✓" : `✗ ${item.kind}`}`).join(" → ")}` : "";
			const warning = outcome.gitAvailable ? "" : "\n\nGit unavailable: read-only mutation verification degraded.";
			const violationText = outcome.violations.length ? `\n\nREAD-ONLY VIOLATION: ${outcome.violations.join("; ")}` : "";
			return {
				content: [{ type: "text", text: truncateUtf8(`${outcome.reviewer ?? "No reviewer"} ${outcome.failed ? "failed" : "completed"} (${profileName}).${chain}\n\n${outcome.text}${violationText}${warning}`, config.maxOutputBytes) }],
				details: { purpose: params.purpose, paths, profile: profileName, attempts: outcome.attempts, violations: outcome.violations },
				isError: outcome.failed,
				usage: combineUsage(outcome.usage),
			};
		},
	});

	pi.registerTool({
		name: "delegate_implementation",
		label: "Delegate implementation",
		description: "Authorize an implementation for the open task. The extension picks the best worker for the profile (Claude Code models, then Gemini), skips providers out of credits, retries transient errors, and hands off to the next candidate on credit/auth/availability failures. Flagship models run only on critical tasks after the user approves them. The profile defaults to the one recorded by plan_task.",
		parameters: Type.Object({
			task: Type.String({ description: "Concise implementation objective; do not repeat the file guide" }),
			profile: Type.Optional(StringEnum(PROFILE_NAMES, { description: `Complexity profile; defaults to the plan_task profile, else ${config.defaultExecutionProfile}. Prefer the stronger profile whenever quality is uncertain.` })),
			effort: Type.Optional(StringEnum(WORKER_EFFORTS, { description: "Raise the profile's Claude effort only when this specific change clearly needs more reasoning (tricky algorithm, subtle concurrency). Lowering is honored only for the small profile; otherwise the profile's effort is kept, because quality comes first." })),
			preferWorker: Type.Optional(StringEnum(["claude", "gemini"] as const, { description: "Only when one family is clearly better suited (e.g. gemini for very large context). Other candidates remain as fallback." })),
			continuePrevious: Type.Optional(Type.Boolean({ description: "Resume the immediately preceding Claude session only for a targeted correction to the same task and authorized paths" })),
			implementationGuide: Type.String({ minLength: Math.min(...Object.values(config.minImplementationGuideChars)), description: "Guide using FILE:, SYMBOLS:, CHANGES:, PRESERVE:, VERIFY:. Be concise where possible, but include every detail needed for reliable execution and mention every allowed path." }),
			acceptanceCriteria: Type.Optional(Type.Array(Type.String({ description: "Concrete, non-duplicative checks" }))),
			allowedPaths: Type.Array(Type.String({ description: "Relative path for every file the worker may modify" }), { minItems: 1 }),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			if (!enabled) throw new Error("SupervisedCoding is disabled. Run /SupervisedCoding on.");
			if (!isAllowedSupervisor(ctx, config)) throw new Error("Only an active supervisor may authorize a worker.");
			const allowedPaths = normalizeAllowedPaths(params.allowedPaths, false);
			const profileName = params.profile ?? openTask()?.profile ?? config.defaultExecutionProfile;
			validateImplementationGuide(params.implementationGuide, allowedPaths, config.minImplementationGuideChars[profileName]);
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
				if (!workerSession || workerSession.cwd !== ctx.cwd) throw new Error("Cannot continue: no compatible previous Claude session is available.");
				// A follow-up step of the same open task may reuse the session on new paths (it already knows the code);
				// scope is still enforced after the run. A different task never inherits a session.
				const sameTask = Boolean(workerSession.taskId && workerSession.taskId === openTask()?.id);
				const outsidePreviousScope = allowedPaths.filter((item) => !pathInAllowedScope(item, workerSession?.allowedPaths ?? []));
				if (outsidePreviousScope.length && !sameTask) throw new Error(`Cannot continue with a broader path scope on a different task. Start a fresh delegation for: ${outsidePreviousScope.join(", ")}`);
				resumeSessionId = workerSession.sessionId;
			} else {
				workerSession = undefined;
			}

			const criteria = params.acceptanceCriteria ?? [];
			// A delegation belongs to the open task (planned with plan_task or already in progress): its flagship answers carry over.
			const open = openTask();
			taskPacket = {
				id: open?.id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				rationale: open?.rationale,
				flagshipDecisions: open?.flagshipDecisions,
				objective: params.task,
				profile: profileName,
				implementationGuide: params.implementationGuide,
				acceptanceCriteria: criteria,
				allowedPaths: [...allowedPaths],
				phase: "implementing",
				updatedAt: Date.now(),
			};
			metrics.delegations++;
			applySupervisorEffort(profileName);
			persist();

			try {
				const repoContext = await repoContextFor(ctx.cwd);
				const verifyCommands = config.autoVerify ? extractVerifyCommands(params.implementationGuide, config.verificationCommands, UNSAFE_COMMAND_CHARS) : [];
				// Baseline first: checks that already failed are reported, never blamed on (or credited to) the worker.
				const baseline = new Map<string, boolean>();
				for (const command of verifyCommands) baseline.set(command, (await runCheck(ctx, command, signal)).ok);
				const spec = { task: params.task, guide: params.implementationGuide, criteria, allowedPaths, profileName, preferWorker: params.preferWorker, effort: params.effort, resumeSessionId, repoContext };
				const outcome = await executeImplementation(ctx, spec, signal, (text, label) => onUpdate?.({ content: [{ type: "text", text: truncateUtf8(text, 4000) }], details: { running: true, profile: profileName, worker: label } }));
				if (outcome.resumed) metrics.resumedDelegations++;
				const final = outcome.final as RunResult;
				const implementer = outcome.finalCandidate as WorkerCandidate;
				const usage = [...outcome.usage];
				let sessionId = implementer.worker === "claude" ? final.sessionId : undefined;
				let failed = outcome.failed;

				// Automatic verification with a bounded correction loop: the worker fixes its own regressions with its context intact.
				let verification: VerificationResult = "unverified";
				let verificationText = "";
				let correctionRounds = 0;
				if (!failed && verifyCommands.length) {
					metrics.autoVerifiedDelegations++;
					let checks = await runChecks(ctx, verifyCommands, signal);
					let regressions = checks.filter((check) => !check.ok && baseline.get(check.command) !== false);
					const notes: string[] = [];
					while (regressions.length && correctionRounds < config.maxCorrectionRounds) {
						correctionRounds++;
						metrics.correctionRounds++;
						onUpdate?.({ content: [{ type: "text", text: `Correction round ${correctionRounds}: ${regressions.map((check) => check.command).join(", ")} failing` }], details: { running: true, profile: profileName, worker: candidateLabel(implementer) } });
						const correction = await runCorrection(ctx, implementer, sessionId, spec, regressions, correctionRounds, signal);
						usage.push(correction.result.usage);
						if (correction.kind) {
							notes.push(`Correction round ${correctionRounds} could not run (${correction.kind}): ${(correction.result.errorMessage ?? "").slice(0, 200)}`);
							break;
						}
						if (implementer.worker === "claude") sessionId = correction.result.sessionId ?? sessionId;
						checks = await runChecks(ctx, verifyCommands, signal);
						regressions = checks.filter((check) => !check.ok && baseline.get(check.command) !== false);
					}
					verification = regressions.length ? "failed" : correctionRounds ? "fixed" : "passed";
					if (regressions.length) failed = true;
					verificationText = formatChecks(checks, baseline, correctionRounds, verification, notes);
				}

				// Scope is checked again: correction rounds edit files too.
				const afterAll = await getGitSnapshot(ctx.cwd);
				const scopeViolations = compareGitSnapshots(outcome.before, afterAll, allowedPaths);
				if (scopeViolations.length) failed = true;
				workerSession = implementer.worker === "claude" && sessionId && !scopeViolations.length
					? { sessionId, cwd: ctx.cwd, allowedPaths: [...allowedPaths], model: implementer.model, taskId: taskPacket?.id }
					: undefined;
				const report = `${outcome.primaryOutput}${verificationText ? `\n\n${verificationText}` : ""}`;
				updateTaskPacket({ phase: failed ? "failed" : "implemented", primaryWorker: candidateLabel(implementer), lastReport: report });

				let reviewText = "";
				let reviewVerdict: ReviewVerdict = "none";
				if (!failed && config.independentReviewProfiles.includes(profileName)) {
					updateTaskPacket({ phase: "reviewing" });
					const question = `Task: ${params.task}\nAcceptance criteria:\n${criteria.length ? criteria.map((item) => `- ${item}`).join("\n") : "- Satisfy the authorized task and repository requirements."}\n${verificationText ? `\nAutomatic checks: ${verification}.\n` : ""}\nLook for correctness bugs, missed requirements, regressions, unsafe behavior, type/API problems, and inadequate tests. If no material defect is found, say so explicitly and list residual risks.`;
					const diff = await scopedDiff(ctx.cwd, allowedPaths, config.maxDiffBytes);
					const review = await runConsultation(ctx, reviewOrder(implementer, profileName), "[INDEPENDENT READ-ONLY CODE REVIEW]", question, allowedPaths, signal, { diff, requireVerdict: true, role: "review" });
					usage.push(...review.usage);
					reviewVerdict = review.verdict;
					reviewText = review.reviewer && !review.failed
						? `Independent review (${review.reviewer}), verdict ${reviewVerdict.toUpperCase()}:\n${review.text}`
						: `INDEPENDENT REVIEW UNAVAILABLE: ${review.text}${review.violations.length ? `\nREAD-ONLY VIOLATION: ${review.violations.join("; ")}` : ""}\nReview the diff yourself before accepting.`;
					updateTaskPacket({ phase: "implemented", lastReport: `${report}\n\n${reviewText}` });
				}

				const combined = combineUsage(usage);
				const learningNotes = await learnFromDelegation(ctx, { implementer, final, profileName, verification, correctionRounds, reviewVerdict, failed, combined });
				if (verification === "passed") metrics.firstPassDelegations++;
				if (failed) metrics.failedDelegations++;
				if (reviewVerdict !== "none") metrics.reviewVerdicts[reviewVerdict] = (metrics.reviewVerdicts[reviewVerdict] ?? 0) + 1;
				persist();
				updateStatus(ctx);
				const usageLine = combined ? `Combined tokens: ${combined.input} in + ${combined.output} out + ${combined.cacheRead} cache-read; reported cost $${combined.cost.total.toFixed(2)}` : "Usage unavailable";
				const safetyLine = scopeViolations.length ? `SAFETY VIOLATIONS: ${scopeViolations.join("; ")}\n` : "";
				const changedLine = afterAll.available ? `Changed files: ${afterAll.changedFiles.join(", ") || "none"}\n` : "Git unavailable: scope enforcement degraded outside Git repositories.\n";
				const verificationLine = verifyCommands.length ? `Automatic verification: ${verification}${correctionRounds ? ` after ${correctionRounds} correction round(s)` : ""}\n` : "Automatic verification: none (no allowlisted command in VERIFY); run_verification before accepting.\n";
				const text = truncateUtf8([
					`${candidateLabel(implementer)} (${profileName}) ${failed ? "failed" : "completed"}.\n${safetyLine}${changedLine}${verificationLine}${usageLine}`,
					outcome.primaryOutput,
					verificationText,
					reviewText,
					learningNotes.length ? `Learning: ${learningNotes.join("; ")}` : "",
				].filter(Boolean).join("\n\n"), config.maxOutputBytes);
				return {
					content: [{ type: "text", text }],
					details: { attempts: outcome.attempts, implementer, before: outcome.before, after: afterAll, scopeViolations, profile: profileName, resumed: outcome.resumed, taskPacketId: taskPacket?.id, verification, correctionRounds, reviewVerdict },
					isError: failed,
					usage: combined,
				};
			} catch (error) {
				// Never leave a stale "implementing" packet behind: recovery logic relies on the phase being accurate.
				updateTaskPacket({ phase: "failed", lastReport: `Delegation aborted: ${error instanceof Error ? error.message : String(error)}` });
				throw error;
			}
		},
	});

	pi.registerTool({
		name: "run_verification",
		label: "Run verification",
		description: "Run one allowlisted test, typecheck, lint or build command in the repository and return its output (the end of it if long). Use it to confirm worker claims: always after a Gemini implementation that could not run checks, and before accepting large or critical work. Shell operators are rejected.",
		parameters: Type.Object({
			command: Type.String({ description: `Must start with one of: ${config.verificationCommands.join(", ")}` }),
		}),
		async execute(_id, params, signal, _update, ctx) {
			if (!enabled) throw new Error("SupervisedCoding is disabled. Run /SupervisedCoding on.");
			const command = params.command.trim().replace(/\s+/g, " ");
			if (UNSAFE_COMMAND_CHARS.test(command)) throw new Error("run_verification rejects shell operators, redirections and variables; pass a single plain command.");
			if (!config.verificationCommands.some((prefix) => command === prefix || command.startsWith(`${prefix} `))) {
				throw new Error(`Command not allowlisted. Allowed prefixes: ${config.verificationCommands.join(", ")} (verificationCommands in config.json).`);
			}
			const check = await runCheck(ctx, command, signal);
			const status = check.timedOut ? `timed out after ${config.verificationTimeoutMinutes} min` : `exit code ${check.exitCode}`;
			const warning = check.changed.length ? `\n\nNote: the command changed files: ${check.changed.join(", ")}` : "";
			return {
				content: [{ type: "text", text: `$ ${command}\n${status}${warning}\n\n${truncateUtf8Tail(check.output, config.maxOutputBytes)}` }],
				details: { command, exitCode: check.exitCode, timedOut: check.timedOut, changed: check.changed },
				isError: !check.ok,
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
			const { lesson, duplicate } = addLesson(learning, repo, params.lesson);
			saveLearningSafe(ctx);
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
			if (taskPacket) updateTaskPacket({ phase: "completed" });
			return { content: [{ type: "text", text: output }], details: { approved: true } };
		},
	});

	pi.registerTool({
		name: "request_git_push",
		label: "Request human-authorized push",
		description: "Run a normal git push, never force-push, only after explicit human confirmation in the UI.",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _update, ctx) {
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
				if (sub === "refresh") ctx.ui.notify((await refreshCredits(ctx)).join("\n"), "info");
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
					learning = { version: 1, outcomes: [], lessons: [], effortAdjustments: {} };
					saveLearningSafe(ctx);
					ctx.ui.notify("Learning data cleared.", "info");
					return;
				}
				if (sub === "forget") {
					ctx.ui.notify(removeLesson(learning, arg) ? `Lesson ${arg} removed.` : `No lesson with id "${arg}".`, "info");
					saveLearningSafe(ctx);
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
				`Config: ${configPath}`,
			].join("\n"), "info");
		},
	});

	// ── Events ─────────────────────────────────────────────────────────────────────────────────

	pi.on("before_agent_start", async (event, ctx) => {
		if (!enabled) return;
		lastUserPrompt = event.prompt;
		supervisorFailoversThisRun = 0;
		await ensureBestSupervisor(ctx, "best available for this prompt");
		applySupervisorEffort();
		updateStatus(ctx);
		if (policyInjected) return;
		policyInjected = true;
		return {
			message: {
				customType: POLICY_TYPE,
				content: "[SUPERVISED CODING]\nGoal: correct, well-made code with as few defects as possible. Quality always beats speed; save tokens only where quality is not affected.\nRoles: you explore, plan, delegate, verify and accept. Workers implement. The extension picks worker models and fails over automatically when a provider runs out of credits; never switch models to hide a coding or test failure.\nWorkflow for every new task:\n1. Read only the files and symbols needed to judge the task (no broad exploration, never paste source into handoffs).\n2. Call plan_task with the profile: small = localized/mechanical; medium = normal multi-file; large = complex architecture or hard debugging; critical = security, concurrency, data migrations or truly exceptional complexity. Choose critical only when a top-tier model is clearly worth it, because it triggers the user's approval for flagship models. When torn between small/medium/large, choose the stronger one.\n3. delegate_implementation with a concise task and a structured guide (FILE:, SYMBOLS:, CHANGES:, PRESERVE:, VERIFY:, every allowedPath mentioned). Use effort only when this specific change needs more or less reasoning than its profile. Use consult_readonly only for concrete uncertainty.\n4. Put the exact test/typecheck/lint commands in VERIFY (e.g. `npm test`, `npx tsc --noEmit`): the extension runs them before and after the change and lets the worker fix regressions itself. Then review diff-stat/diff-names and scoped diffs; use run_verification for anything VERIFY could not cover.\n5. For corrections or follow-up steps of the same task use continuePrevious=true; do not call plan_task again for the same task.\n6. When a failure, correction round or review finding reveals a durable repository-specific pitfall, call record_lesson with one concrete instruction; never record task-specific details.\nIf the supervisor model changes after a provider failure, re-check the task state and Git status before continuing and do not redo completed delegations. Final acceptance is your responsibility. Commit/push only through the confirmation tools; never merge.",
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
