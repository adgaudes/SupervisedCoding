import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
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
	cheapestDelegationTokens,
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
import { entryName, formatOutline, formatReferences, outlineSource, outlineSupported, type ReferenceMatch } from "./outline.ts";
import { compressPaths, enclosingRanges, FINDINGS_FORMAT, formatFinding, hunkRanges, mapLimit, mergeFindings, packShards, parseFindings, parseVerification, renderRanges, splitDiff, touchedDeclarations, type Finding } from "./review.ts";
import { planContextEdits } from "./pruning.ts";
import { formatCommand, parseAllowlist, parseCommand, resolveLauncher, UNSAFE_COMMAND_CHARS, verificationCommand, type Launch } from "./verification.ts";
import { type ProcessOutcome, resolveClaudeCommand, runProcess, truncateUtf8, truncateUtf8Middle, truncateUtf8Tail } from "./process-runner.ts";
import {
	candidateLabel,
	type Config,
	CONSULT_FAMILIES,
	type ConsultReviewer,
	DEFAULT_WORKER_CHAINS,
	type ExecutionProfileName,
	isAllowedSupervisor,
	loadConfig,
	mergeConfig,
	modelDisplayName,
	modelFamily,
	orderChain,
	OUTPUT_LIMIT_DEFAULTS,
	type OutputLimits,
	PROFILE_NAMES,
	type RawConfig,
	resolveEffort,
	type SupervisorCandidate,
	supervisorHealthKeys,
	type ThinkingLevel,
	type WorkerCandidate,
	type WorkerEffort,
	type WorkerKind,
	WORKER_EFFORTS,
	workerHealthKeys,
} from "./config.ts";
import {
	branchDiff,
	compareGitSnapshots,
	fileFingerprint,
	filesChangedBetween,
	getGitSnapshot,
	type GitSnapshot,
	gitStdout,
	normalizeAllowedPaths,
	normalizeSupervisorPath,
	nulSeparated,
	pathInAllowedScope,
	resolveReviewBase,
	runGit,
	safeRunGit,
	scopedDiff,
	workingTreeFingerprint,
} from "./git-safety.ts";

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
const CUSTOM_TOOLS = new Set(["plan_task", "complete_task", "consult_readonly", "review_changes", "delegate_implementation", "run_verification", "code_outline", "record_lesson", "supervisor_git", "request_git_commit", "request_git_push"]);
const MAX_STORED_REPORT_CHARS = 8000;
/** data/usage.jsonl rotates to usage.jsonl.1 beyond this size, so the invocation log stays bounded. */
const USAGE_LOG_MAX_BYTES = 5 * 1024 * 1024;
const FLAGSHIP_YES = "Yes";
const FLAGSHIP_NO = "No";
const assessmentSchema = Type.Object({
	kind: Type.Optional(StringEnum(TASK_KINDS)),
	risk: Type.Optional(StringEnum(["low", "medium", "high"] as const)),
	uncertainty: Type.Optional(StringEnum(["low", "medium", "high"] as const)),
	scope: Type.Optional(StringEnum(["local", "multi-file", "cross-system"] as const)),
}, { description: "Assess consequences, uncertainty and scope, not just line count. Security/concurrency/migrations and high risk require critical; architecture/high uncertainty require large. Omitted fields use conservative defaults." });

type SessionWorker = "claude" | "pi";

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
	/** Bytes of supervisor context replaced by short notes (context pruning), and how many results. */
	contextPrunedBytes: number;
	contextPrunedResults: number;
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
	/**
	 * Checks that could not start after a worker: nothing showed them failing only the way they did at the task
	 * start, so only a passing run of the same command clears them (run_verification, or the final automatic checks
	 * of a later delegation). Task-level: they carry over to later delegations and keep the task failed until then.
	 * When failedChecks is set, it includes them.
	 */
	launchFailedChecks?: string[];
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
	contextPrunedBytes: 0,
	contextPrunedResults: 0,
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
 * Repository context for a fresh worker: instruction files (workers run in --safe-mode and would not load them)
 * and lessons learned in this repository. Resumed sessions already have it.
 */
function buildRepoContext(rules: string, lessons: string[]): string {
	const parts: string[] = [];
	if (rules) parts.push(`REPOSITORY RULES (follow them)\n${rules}`);
	if (lessons.length) parts.push(`LESSONS FROM PREVIOUS WORK IN THIS REPOSITORY (avoid repeating these mistakes)\n${lessons.map((item) => `- ${item}`).join("\n")}`);
	return parts.join("\n\n");
}

function buildWorkerPrompt(task: string, implementationGuide: string, acceptanceCriteria: string[], allowedPaths: string[], isContinuation: boolean, repoContext = "", codeMap = ""): string {
	return `[CODING WORKER — ${isContinuation ? "TARGETED CORRECTION" : "EXECUTE, DO NOT REPLAN"}]
${!isContinuation && repoContext ? `${repoContext}\n\n` : ""}Implement only the task and file guide below. ${isContinuation ? "Reuse the existing session context; inspect only what changed or what the correction explicitly references." : "Check Git status first; preserve existing changes."} Never weaken, skip or delete tests to make checks pass. Start from the named symbols and use narrow/ranged reads where possible, expanding only when dependencies or uncertainty require it. Edit surgically and avoid broad exploration or unrelated refactors. Never stage, commit, push, merge, switch branches, rewrite history, or invoke agents. Do not modify paths outside the allowlist. If instructions conflict with the code or admit multiple material approaches, stop and report the ambiguity. Run pertinent checks. On success return only changed files, concise change summary, tests and residual risks; on failure include the diagnostics needed to resolve it.

TASK
${task}

FILE GUIDE (primary source of truth)
${implementationGuide}
${!isContinuation && codeMap ? `
CODE MAP (generated from the current files; line ranges are approximate: read only the ranges you need)
${codeMap}
` : ""}
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
/**
 * A directory's real path: symlinks resolved and, on Windows, an 8.3 short name expanded. Git always answers with the
 * real path, while the directory Pi was started from can be a symlinked or shortened spelling of the same place
 * (/tmp on macOS, C:\Users\RUNNER~1 on a CI runner). Rule discovery compares the two as text, so without this a
 * nested AGENTS.md beside an authorized path is silently lost and the repository root is read twice.
 */
function realDir(dir: string): string {
	try {
		return fs.realpathSync.native(dir);
	} catch {
		return path.resolve(dir); // Not a real directory (yet): the plain resolution is the best answer available.
	}
}

function ruleDirs(cwd: string, gitRoot: string | undefined, allowedPaths: string[]): string[] {
	const here = realDir(cwd);
	const root = realDir(gitRoot ?? cwd);
	const dirs = [root, here];
	for (const item of allowedPaths) {
		let dir = path.resolve(here, item);
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
	// The same canonical form ruleDirs used, so a rule file is labelled by its short relative path and never twice.
	const base = realDir(cwd);
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
				const label = path.relative(base, file) || name;
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

/** Text files under the paths, with sizes, in path order (what an audit covers). */
async function sourceInventory(cwd: string, paths: string[]): Promise<Array<{ file: string; bytes: number }>> {
	const listed = await gitStdout(cwd, ["--literal-pathspecs", "ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", ...paths]);
	const files = listed !== undefined ? nulSeparated(listed) : paths.flatMap((item) => {
		try { return fs.statSync(path.join(cwd, item)).isDirectory() ? walkFiles(cwd, item) : [item]; } catch { return []; }
	});
	const inventory: Array<{ file: string; bytes: number }> = [];
	for (const file of [...new Set(files)].sort()) {
		if (file.split("/").some((part) => SKIPPED_DIRS.has(part))) continue;
		try {
			const stat = fs.statSync(path.join(cwd, file));
			// Larger files are generated or data: no consultant reads them whole.
			if (stat.isFile() && stat.size > 0 && stat.size <= 1_000_000) inventory.push({ file, bytes: stat.size });
		} catch {
			// Deleted in the working tree.
		}
	}
	return inventory;
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
	// Guides written as one paragraph ("FILE: a.ts. SYMBOLS: … VERIFY: npm test.") get one section per line, so
	// sections and VERIFY commands are found wherever the supervisor put them.
	const trimmed = guide.trim().replace(/([.;])[ \t]+(?=(?:FILES?|SYMBOLS?|CHANGES?|CHANGE\/CHANGES|PRESERVE|VERIFY|ACCEPTANCE)\s*:)/g, "$1\n");
	if (trimmed.length < minChars) {
		throw new Error(`Delegation blocked: implementationGuide is too short (${trimmed.length}/${minChars} chars).`);
	}
	const has = (section: string) => new RegExp(`(^|\\n)\\s*${section}S?(?:\\/\\w+)?\\s*:`, "i").test(trimmed);
	// "FILE: path: what changes there" carries the changes per file: a CHANGES header would only repeat it.
	const describedFiles = /(^|\n)\s*FILES?\s*:\s*\S+?\s*(?::|—|–|-)\s+\S.{19,}/i.test(trimmed);
	const missing = ["FILE", "CHANGE", "VERIFY"].filter((section) => !has(section) && !(section === "CHANGE" && describedFiles));
	if (missing.length) {
		throw new Error(`Delegation blocked: implementationGuide is missing required sections: ${missing.join(", ")}. Use FILE:, SYMBOLS:, CHANGES:, PRESERVE:, VERIFY:.`);
	}
	// Authorized paths the guide does not name are listed for the worker instead of costing a supervisor turn.
	const absentPaths = allowedPaths.filter((file) => !trimmed.includes(file));
	const defaulted = Object.keys(GUIDE_DEFAULTS).filter((section) => !has(section));
	return {
		guide: [trimmed, ...defaulted.map((section) => GUIDE_DEFAULTS[section]), ...(absentPaths.length ? [`ALSO AUTHORIZED (edit only if the change requires it): ${absentPaths.join(", ")}`] : [])].join("\n"),
		defaulted,
	};
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
		if (typeof script !== "string") return command;
		// Commands are canonical (formatCommand); a script that is not one plain command matches none of them.
		try {
			return formatCommand(parseCommand(script));
		} catch {
			return script.trim();
		}
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

/** What a review gets besides the diff: see reviewMaterial. */
interface ReviewMaterial {
	/** Added to every reviewer's prompt. */
	context: string;
	/** Added instead for an API reviewer that gets whole files (the code around the changes would repeat them). */
	apiContext: string;
	/** Inline files for the API reviewer; undefined when they do not fit (the API reviewer is skipped). */
	apiFiles?: string;
	apiWhole: boolean;
}

/**
 * The delegation diff shown in its result. The supervisor reviews the diff anyway: showing it there saves the turn
 * that would fetch it with supervisor_git, and context pruning shortens it once the task is accepted.
 */
const RESULT_DIFF_BYTES = 24_000;

/** Repository rules given to reviewers and consultants: the part that bears on judging code, not all of it. */
const REVIEW_RULES_BYTES = 8000;

/** Files shorter than this are read whole by a worker anyway: they get no map. */
const CODE_MAP_MIN_LINES = 500;

/**
 * A map for a fresh worker of the large authorized files: their outline with line ranges (only the declarations
 * the guide names, and those enclosing them, when the whole outline is long), then where the named declarations are
 * used, so the worker reads ranges instead of whole files and sees the callers it must keep working.
 */
async function workerCodeMap(cwd: string, allowedPaths: string[], guide: string, maxBytes: number): Promise<string> {
	const named = (name: string) => /^[\w$]{3,}$/.test(name) && new RegExp(`(^|[^\\w$])${name.replace(/\$/g, "\\$")}([^\\w$]|$)`).test(guide);
	const outlines: string[] = [];
	const symbols = new Set<string>();
	let used = 0;
	for (const file of allowedPaths) {
		if (!outlineSupported(file)) continue;
		let source: string;
		try {
			const absolute = path.join(cwd, file);
			const stat = fs.statSync(absolute);
			if (!stat.isFile() || stat.size > 2_000_000) continue;
			source = fs.readFileSync(absolute, "utf8");
		} catch {
			continue; // Not created yet.
		}
		if (source.split(/\r?\n/).length < CODE_MAP_MIN_LINES) continue;
		const entries = outlineSource(file, source);
		const wanted = entries.filter((entry) => named(entryName(entry.text)));
		wanted.forEach((entry) => symbols.add(entryName(entry.text)));
		let text = formatOutline(file, source);
		if (Buffer.byteLength(text, "utf8") > maxBytes / 2) {
			// Too long whole: the named declarations and what encloses them, else the top level.
			text = wanted.length
				? formatOutline(file, source, 400, (entry) => wanted.some((item) => entry === item || (entry.line <= item.line && item.end <= entry.end)))
				: formatOutline(file, source, 400, (entry) => entry.depth === 0);
		}
		const size = Buffer.byteLength(text, "utf8") + 2;
		if (used + size > (maxBytes * 2) / 3) continue;
		outlines.push(text);
		used += size;
	}
	if (!outlines.length) return "";
	let uses = "";
	if (symbols.size) {
		try {
			uses = truncateUtf8(await findReferences(cwd, [...symbols].slice(0, 5), ["."], { usesOnly: true }), Math.max(1000, maxBytes - used));
		} catch {
			// Outside Git: no reference search.
		}
	}
	return [outlines.join("\n\n"), uses ? `Uses of the declarations named in the guide (matched by name):\n${uses}` : ""].filter(Boolean).join("\n\n");
}

/** An audit may ask for defects or for an explanation: findings lines only fit the first. */
const AUDIT_FORMAT = `When the question asks for defects, risks or a review, answer with findings.\n${FINDINGS_FORMAT}\nWhen it asks for an explanation or a map of the code instead, answer it concisely with file:line references and no findings lines.`;

/** Files at most this long are given whole to an API reviewer on focused material; longer ones as outlines. */
const FOCUSED_WHOLE_FILE_LINES = 400;

/**
 * Review material for a diff: the declarations around each change and the uses of the declarations it touches
 * (reviewers then need fewer reads, and callers a change breaks are in plain sight), plus inline files for the API
 * reviewer: whole when they fit reviewWholeFilesBytes; up to 250 KB, small files whole and outlines of large ones,
 * with the code around the changes; beyond that none, so a reviewer that can browse is used.
 */
async function reviewMaterial(cwd: string, diff: string, files: string[], config: Config): Promise<ReviewMaterial> {
	const sources = new Map<string, string | undefined>();
	const read = (file: string): string | undefined => {
		if (!sources.has(file)) {
			try {
				const buffer = fs.readFileSync(path.join(cwd, file));
				sources.set(file, buffer.includes(0) ? undefined : buffer.toString("utf8"));
			} catch {
				sources.set(file, undefined);
			}
		}
		return sources.get(file);
	};
	const fileDiffs = splitDiff(diff);
	const aroundBudget = Math.floor((config.reviewContextBytes * 2) / 3);
	const blocks: string[] = [];
	let used = 0;
	let omitted = 0;
	for (const fileDiff of fileDiffs) {
		const source = read(fileDiff.file);
		if (source === undefined) continue;
		const ranges = enclosingRanges(fileDiff.file, source, hunkRanges(fileDiff.text));
		if (!ranges.length) continue;
		const block = renderRanges(fileDiff.file, source, ranges);
		const size = Buffer.byteLength(block, "utf8") + 2;
		if (used + size > aroundBudget) { omitted++; continue; }
		blocks.push(block);
		used += size;
	}
	const signatures: string[] = [];
	const bodies: string[] = [];
	for (const fileDiff of fileDiffs) {
		const touched = touchedDeclarations(fileDiff, read(fileDiff.file));
		signatures.push(...touched.signatures);
		bodies.push(...touched.bodies);
	}
	const names = [...new Set([...signatures, ...bodies])].slice(0, 8);
	let uses = "";
	if (names.length) {
		try {
			uses = truncateUtf8(await findReferences(cwd, names, ["."], { usesOnly: true }), Math.max(2000, config.reviewContextBytes - used));
		} catch {
			// Outside Git: no reference search.
		}
	}
	const around = blocks.length ? `CODE AROUND THE CHANGES (current content, numbered)${omitted ? ` — ${omitted} more file(s) omitted for size: read them if needed` : ""}\n${blocks.join("\n\n")}` : "";
	const usesBlock = uses ? `USES OF THE DECLARATIONS THE CHANGE TOUCHES (matched by name, like grep; check callers the change could break)\n${uses}` : "";
	let apiFiles = collectFiles(cwd, files, config.reviewWholeFilesBytes);
	const apiWhole = apiFiles !== undefined;
	if (!apiWhole && collectFiles(cwd, files, 250_000) !== undefined) {
		apiFiles = files.map((file) => {
			const source = read(file);
			if (source === undefined) return "";
			const lines = source.split(/\r?\n/).length;
			return lines <= FOCUSED_WHOLE_FILE_LINES ? `=== ${file} ===\n${source}` : `=== ${file} (outline only: ${lines} lines; the code around the changes is above) ===\n${formatOutline(file, source)}`;
		}).filter(Boolean).join("\n\n");
	}
	return { context: [around, usesBlock].filter(Boolean).join("\n\n"), apiContext: usesBlock, apiFiles, apiWhole };
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
async function findReferences(cwd: string, symbols: string[], paths: string[], options: { usesOnly?: boolean } = {}): Promise<string> {
	if (!(await gitStdout(cwd, ["rev-parse", "--show-toplevel"]))) throw new Error("References need a Git repository.");
	const parts: string[] = [];
	for (const raw of symbols) {
		const symbol = raw.trim();
		if (!/^[\w$]+(?:\.[\w$]+)*$/.test(symbol)) throw new Error(`Not a symbol name: ${raw}`);
		// A qualified name (Store.add) is searched by its last part: calls rarely spell the qualifier.
		const name = symbol.split(".").at(-1)!;
		// Exit code 1 (no match) reads as no output.
		const output = await gitStdout(cwd, ["-c", "core.quotepath=off", "--literal-pathspecs", "grep", "--untracked", "-I", "-n", "-z", "-w", "-F", "--no-color", "-e", name, "--", ...paths]);
		let matches: ReferenceMatch[] = [];
		for (const line of (output ?? "").split("\n").filter(Boolean)) {
			const [file, number, ...text] = line.split("\0");
			if (file && number) matches.push({ file: normalizeSupervisorPath(file), line: Number(number), text: text.join("\0") });
		}
		const sources: Record<string, string | undefined> = {};
		const load = (file: string) => {
			if (!(file in sources) && outlineSupported(file)) {
				try { sources[file] = fs.readFileSync(path.join(cwd, file), "utf8"); } catch { sources[file] = undefined; /* Deleted meanwhile. */ }
			}
		};
		if (options.usesOnly) {
			// Uses only: drop the declaration and every line inside it (its own body is shown elsewhere).
			const inside = new Map<string, Array<[number, number]>>();
			matches = matches.filter((match) => {
				load(match.file);
				const source = sources[match.file];
				if (source === undefined) return true;
				if (!inside.has(match.file)) inside.set(match.file, outlineSource(match.file, source).filter((entry) => entryName(entry.text) === name).map((entry): [number, number] => [entry.line, entry.end]));
				return !inside.get(match.file)!.some(([start, end]) => start <= match.line && match.line <= end);
			});
		}
		for (const file of new Set(matches.slice(0, 60).map((match) => match.file))) load(file);
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
	/** Outline and uses of the guide's symbols in large authorized files, for fresh workers. */
	codeMap?: string;
	/** The delegation's allowlisted VERIFY commands: the worker is authorized to run exactly these. */
	verificationCommands?: string[];
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
	const config = loadConfig(configPath, userConfigPath, CUSTOM_TOOLS);
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
	/**
	 * Files whose whole diff against HEAD a delegation result showed, with their content at that point. Cleared when
	 * those results may leave the supervisor's context (task accepted, context pruned, compaction).
	 */
	const shownDiffs = new Map<string, string>();
	/**
	 * The last review_changes of each branch (working directory, merge base, scope) in this session: the reviewed
	 * content, the findings and how many reviews it had. In memory only; a Map keeps insertion order.
	 */
	const branchReviews = new Map<string, { checkpoint: Checkpoint; files: string[]; findings: string[]; count: number }>();
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

	function statusText(ctx: ExtensionContext, currentModel: Pick<Model<any>, "provider" | "id"> | undefined = ctx.model, thinkingLevel = pi.getThinkingLevel()): string {
		const model = currentModel ? `${currentModel.provider}/${currentModel.id}` : "no model";
		const task = openTask() ? ` · ${taskPacket?.profile}` : "";
		return `${EXTENSION_NAME} ${model}/${thinkingLevel}${supervisorMode === "auto" ? " (auto)" : ""}${task} · C${metrics.claudeAttempts} P${metrics.piRuns} · ${metrics.providerFailovers + metrics.supervisorFailovers} failovers`;
	}

	function updateStatus(ctx: ExtensionContext, currentModel?: Pick<Model<any>, "provider" | "id">, thinkingLevel = pi.getThinkingLevel()): void {
		ctx.ui.setStatus(STATE_TYPE, ctx.ui.theme.fg("accent", statusText(ctx, currentModel, thinkingLevel)));
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
			fs.appendFileSync(usageLog, JSON.stringify({ at: Date.now(), taskId: openTask()?.id, role, worker: result.worker, provider: result.provider, model: result.model, billing: result.billing ?? "unknown", usage: result.usage, costUsd: result.costUsd, measured: Boolean(result.usage), failed: runFailed(result), timedOut: result.timedOut }) + "\n");
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
		/** The command could not be started: never a result about the code, never reused or taken as a baseline. */
		launchError?: string;
	}

	/**
	 * Last result of each command, with the repository state it ran on. Within one user prompt only workers change
	 * files (the supervisor has no shell, consultants and reviewers are read-only), so the same state gives the same
	 * result: the next delegation's start need not run again the checks that closed the previous one. Results are
	 * dropped whenever a worker starts, since a worker may also write files ignored by Git, which the fingerprint
	 * does not cover. Only runs that left the state as they found it are kept.
	 */
	const checkResults = new Map<string, { cwd: string; promptSeq: number; fingerprint: string; result: CheckResult }>();
	/** Path sets already questioned for an optimistic assessment: each is questioned once, so no call can loop. */
	const assessmentQuestioned = new Set<string>();
	/**
	 * Checks the supervisor ran itself, with the working tree they ran on. Kept apart from checkResults, which exists
	 * for reuse and therefore holds nothing when reuse is off, and which forgets a check that failed to leave the tree
	 * untouched. Acceptance of a change the supervisor made itself rests on these, so they must survive both.
	 */
	const ownChecks: Array<{ cwd: string; promptSeq: number; fingerprint: string | undefined; command: string; ok: boolean }> = [];

	function checkReuseEnabled(): boolean {
		return config.reuseChecks && !config.supervisorTools.includes("bash");
	}

	/** pass; unchanged = red since the task started and failing the same way; changed/regression block the task. */
	type CheckState = "pass" | "unchanged" | "changed" | "regression";

	/**
	 * How a check compares with the task's start. A check red since then is tolerated only while its failure
	 * signature matches the one recorded then: a new failure inside an already-red command (another test, a
	 * different error, other counts) is a regression. Without a recorded signature nothing proves the failure
	 * unchanged, so it counts as changed. A check that could not start proves nothing: always a regression.
	 */
	function classifyCheck(check: CheckResult, redAtStart: boolean, startSignature: string | undefined): CheckState {
		if (check.ok && !check.launchError) return "pass";
		if (!redAtStart || check.launchError) return "regression";
		return startSignature !== undefined && check.signature === startSignature ? "unchanged" : "changed";
	}

	/**
	 * One allowlisted check, non-interactive (CI=1 keeps test runners out of watch mode). With reuse, a result from
	 * this prompt on exactly the same repository state is returned instead of running the command again.
	 */
	async function runCheck(ctx: ExtensionContext, command: string, signal: AbortSignal | undefined, reuse = false): Promise<CheckResult> {
		// The same parsing and allowlist decision as VERIFY extraction and run_verification: nothing else can run.
		const { argv } = verificationCommand(command, config.verificationCommands);
		const fingerprint = checkReuseEnabled() ? await workingTreeFingerprint(ctx.cwd) : undefined;
		const known = checkResults.get(command);
		if (reuse && fingerprint && known && known.fingerprint === fingerprint && known.cwd === ctx.cwd && known.promptSeq === promptSeq) {
			metrics.reusedChecks++;
			return { ...known.result, changed: [], safetyViolations: [], reused: true };
		}
		const before = await getGitSnapshot(ctx.cwd);
		let launch: Launch | undefined;
		let unresolved: string | undefined;
		try {
			launch = resolveLauncher(argv);
		} catch (error) {
			unresolved = error instanceof Error ? error.message : String(error);
		}
		// No shell: the executable receives the parsed arguments as they are.
		const outcome: ProcessOutcome = launch
			? await runProcess(launch.command, launch.args, "", ctx.cwd, signal, minutes(config.verificationTimeoutMinutes), undefined, { maxBytes: config.maxProcessOutputBytes, env: { CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" } })
			: { exitCode: 1, stdout: "", stderr: "", aborted: false, timedOut: false, launchError: unresolved };
		if (outcome.aborted) throw new Error("Verification aborted.");
		const afterRun = await getGitSnapshot(ctx.cwd);
		if (!outcome.launchError) metrics.verifications++;
		const ok = !outcome.launchError && outcome.exitCode === 0 && !outcome.timedOut;
		const output = outcome.launchError
			? `Could not start ${command}: ${outcome.launchError}`
			: `${outcome.stdout}${outcome.stderr ? `\n[stderr]\n${outcome.stderr}` : ""}`.trim() || "(no output)";
		const result: CheckResult = {
			command,
			ok,
			exitCode: outcome.exitCode,
			timedOut: outcome.timedOut,
			output,
			changed: filesChangedBetween(before, afterRun),
			// Every path is in scope here ("."), so only branch, HEAD and staged-content changes are reported.
			safetyViolations: compareGitSnapshots(before, afterRun, ["."]),
			// A command that could not start has no signature: it can never pass as "failing the same way".
			signature: ok || outcome.launchError ? undefined : failureSignature(`${outcome.timedOut ? "timed out" : `exit code ${outcome.exitCode}`}\n${output}`),
			launchError: outcome.launchError,
		};
		// Timeouts and launch failures say nothing stable about the code; a run that changed the state is valid for no state left.
		const after = fingerprint && !outcome.timedOut && !outcome.launchError && !result.changed.length && !result.safetyViolations.length ? await workingTreeFingerprint(ctx.cwd) : undefined;
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
		const lines = checks.map((check) => `- ${check.command}: ${check.launchError ? "FAIL (could not start)" : CHECK_STATE_TEXT[classify(check)]}${check.safetyViolations.length ? ` — GIT SAFETY VIOLATION: ${check.safetyViolations.join("; ")}` : ""}`);
		const failing = checks
			.filter((check) => !check.ok && (firstDelegation || classify(check) !== "unchanged"))
			.map((check) => `$ ${check.command}\n${check.launchError ? "not started" : check.timedOut ? "timed out" : `exit code ${check.exitCode}`}\n${truncateUtf8Tail(check.output, classify(check) === "unchanged" ? 800 : 4000)}`);
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
		lines.push(`Routing: failovers workers ${metrics.providerFailovers}, supervisor ${metrics.supervisorFailovers} · flagship asked ${metrics.flagshipRequests} (${metrics.flagshipApprovals} approved) · consultations ${metrics.readOnlyConsultations} · resumed sessions ${metrics.resumedDelegations} · checks run ${metrics.verifications}, reused ${metrics.reusedChecks} · context pruned ${metrics.contextPrunedResults} result(s), ${Math.round(metrics.contextPrunedBytes / 1024)} KB`);
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
		// The delegation's first worker run always starts: the time the extension spent on its own task-start checks
		// never takes the authorized work away. Retries, failovers, corrections and the review are still checked.
		let firstRun = !spec.role || spec.role === "implement";
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
			let basePrompt = buildWorkerPrompt(spec.task, spec.guide, spec.criteria, spec.allowedPaths, Boolean(resumeId), spec.repoContext, spec.codeMap);
			if (resumeId && spec.resumePrompt) {
				basePrompt = spec.resumePrompt;
				handoff = "";
			}
			let result: RunResult | undefined;
			let kind: FailureKind | undefined;
			let stoppedBy: string | undefined;
			for (let attempt = 0; attempt <= config.transientRetryAttempts; attempt++) {
				// The cumulative delegation budget is checked before every later paid attempt, never during one.
				stoppedBy = firstRun ? undefined : budgetExceeded();
				firstRun = false;
				if (stoppedBy) break;
				if (activeBudget && config.delegationBudgetUsd > 0) candidate.maxBudgetUsd = Math.max(0.001, config.delegationBudgetUsd - activeBudget.spent);
				const fullPrompt = `${handoff ? `${handoff}\n\n` : ""}${basePrompt}`;
				// What each worker may run differs: a Claude worker is authorized for the checks the extension runs (the Bash
				// rules derived from verificationCommands) and a Pi worker usually has no shell at all. Neither may claim a
				// check it could not run, so both are told which commands they have.
				const authorizedChecks = spec.verificationCommands ?? [];
				const commandRule = candidate.worker === "claude"
					? authorizedChecks.length
						? `Do not run the project's checks yourself: the extension runs them on your finished work (${authorizedChecks.join(", ")}) and hands you any failure to fix, and their output would weigh on every later turn of yours. Any other shell command may be denied.`
						: "Any shell command other than reading Git state may be denied."
					: config.piWorkerTools.includes("bash")
						? "Do not run the project's checks yourself: the extension runs the guide's VERIFY commands on your finished work."
						: "Shell tools are unavailable to you.";
				const workerNotes = `\n\n[WORKER NOTES]\nEdit only the allowlisted paths and preserve pre-existing changes. Never stage, commit, push, merge, change branches, or rewrite Git history. ${commandRule} Never claim a check passed that you could not run: the extension runs the VERIFY commands after you finish; list any other verification the supervisor should run.`;
				if (candidate.worker === "claude") {
					result = await runClaude(ctx.cwd, config, candidate, "edit", `${fullPrompt}${workerNotes}`, resumeId, signal, minutes(config.workerTimeoutMinutes), (text) => onProgress?.(text, label));
				} else {
					result = await runPiWorker(ctx, candidate, "edit", `${fullPrompt}${workerNotes}`, resumeId, signal, minutes(config.workerTimeoutMinutes), (text) => onProgress?.(text, label));
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
	async function runConsultation(ctx: ExtensionContext, order: WorkerCandidate[], header: string, question: string, paths: string[], signal: AbortSignal | undefined, options: { diff?: string; diffComplete?: boolean; diffLabel?: string; requireVerdict?: boolean; role?: UsageRole; maxTurns?: number; findings?: boolean; instructions?: string; material?: ReviewMaterial } = {}): Promise<ConsultOutcome> {
		const { usable, blocked } = rankCandidates(order, workerHealthKeys, health, config.creditHeadroom);
		const attempts: AttemptRecord[] = blocked.map((item) => ({ label: candidateLabel(item.candidate), ok: false, kind: "credits" as FailureKind, detail: "skipped: exhausted", order: item.index }));
		const usage: Array<Usage | undefined> = [];
		const before = await getGitSnapshot(ctx.cwd);
		let text = usable.length ? "" : `No read-only reviewer available (${describeBlocked(blocked)}).`;
		let reviewer: string | undefined;
		let failed = true;
		const pathList = paths.map((item) => `- ${item}`).join("\n");
		// Reviewers run without the repository's instruction files (safe mode, no context files): without them they
		// cannot judge the code against the project's own rules.
		const rules = readRepoRules(ctx.cwd, ruleDirs(ctx.cwd, await gitRoot(ctx.cwd), paths), config.repoRulesFiles, REVIEW_RULES_BYTES);
		const rulesBlock = rules ? `\n\nREPOSITORY RULES (judge the code against them)\n${rules}` : "";
		const diffBlock = options.diff ? `\n\nCHANGES UNDER REVIEW (${options.diffLabel ?? "made by this delegation"})\n\`\`\`diff\n${options.diff}\n\`\`\`\nBase the review on these changes; read files only for the surrounding context you need.` : "";
		const verdictLine = options.requireVerdict ? "\nEnd with exactly one final line: VERDICT: PASS (no material defect) | MINOR (only minor issues) | MAJOR (bugs, missed requirements, regressions or unsafe behavior)." : "";
		let material: string | undefined | null = null;
		for (const { candidate: configured, index: order } of usable) {
			if (isFlagship(configured.model) || availability(health, workerHealthKeys(configured), config.creditHeadroom).state === "blocked") continue;
			const candidate: WorkerCandidate = options.maxTurns ? { ...configured, maxTurns: options.maxTurns } : configured;
			const label = candidateLabel(candidate);
			// An API reviewer given whole files would read the code around the changes twice.
			const extra = options.material ? (candidate.worker === "api" && options.material.apiWhole ? options.material.apiContext : options.material.context) : "";
			const guidance = options.instructions ?? (options.findings ? FINDINGS_FORMAT : "Return concise findings ordered by severity, concrete evidence with file/symbol references, recommended action, verification ideas, and remaining uncertainty. Do not summarize unrelated code.");
			const prompt = `${header}\n${question}\nRelevant paths:\n${pathList}${rulesBlock}${diffBlock}${extra ? `\n\n${extra}` : ""}\n\nInspect only the listed paths and directly relevant symbols. Do not edit, write, stage, commit, push, merge, switch branches, or run mutating commands.\n${guidance}${verdictLine}`;
			if (candidate.worker === "api") {
				if (options.diffComplete === false || options.diff?.includes("[Diff truncated")) { attempts.push({ label, ok: false, detail: "skipped: incomplete review material requires browsing", order }); continue; }
				// An API reviewer cannot browse: it needs the files inline, and only when they fit.
				if (material === null) material = options.material ? options.material.apiFiles : collectFiles(ctx.cwd, paths, 250_000);
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
		updateStatus(ctx, target.model);
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
			if (!enabled) throw new Error("SupervisedCoding is disabled. Run /SupervisedCoding on.");
			if (delegationRunning) throw new Error("Wait for the running delegation before completing the task.");
			// A change the supervisor made itself has no task packet: no plan_task, no delegation, so no worker outcome
			// and no per-delegation review. Its checks are the whole evidence there is, so acceptance requires them.
			if (!openTask()) {
				if (!taskPacket && params.decision === "pause") throw new Error("No supervised task to pause.");
				const fingerprint = await workingTreeFingerprint(ctx.cwd);
				const mine = ownChecks.filter((item) => item.cwd === ctx.cwd && item.promptSeq === promptSeq);
				// Only what was run on the code as it stands counts: a result from before a later edit is neither proof
				// nor a blocker, it is stale and has to be run again. Outside a Git repository neither side has a
				// fingerprint and nothing can tell the two apart, so the check counts, as everywhere else the extension
				// degrades when Git is unavailable. One verdict per command, the last one, so a failure that was then
				// fixed and re-run on the same code does not block for the rest of the prompt.
				const current = new Map<string, boolean>();
				for (const item of mine) {
					if (item.fingerprint === undefined || fingerprint === undefined || item.fingerprint === fingerprint) current.set(item.command, item.ok);
				}
				const failing = [...current].filter(([, ok]) => !ok).map(([command]) => command);
				if (failing.length) throw new Error(`Cannot accept a change of your own while ${failing.join(", ")} fails: fix it and run the check again.`);
				const own = [...current.keys()];
				if (!own.length) {
					throw new Error(mine.length
						? `Cannot accept: ${[...new Set(mine.map((item) => item.command))].join(", ")} ran on code you have since changed. Run the checks again on the current code, then accept.`
						: "Nothing to accept: no task is open and no check of yours ran in this prompt. Run the project's checks with run_verification first, or delegate the change.");
				}
				supervisorFlagshipGrant = undefined;
				carriedTaskId = undefined;
				applySupervisorEffort();
				persist(); updateStatus(ctx);
				return { content: [{ type: "text", text: `Change of your own accepted on its checks: ${own.join(", ")}. No delegation was involved, so nothing was recorded for worker learning.` }], details: { decision: params.decision, accepted: true, direct: true, checks: own } };
			}
			if (!taskPacket) throw new Error("No supervised task to complete.");
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
							updateTaskPacket({ phase: "failed", reviewVerdict: "major", reviewScope: "task", failedChecks: undefined });
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
				// Context pruning shortens this task's delegation results: their diffs may no longer be in context.
				shownDiffs.clear();
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
			const pool = consultOrder(params.reviewer ?? "auto", profileName);
			if (params.purpose === "audit") {
				// More source than one consultant should hold is split by directory among parallel consultants; each
				// holds only its part in context, and the supervisor gets one merged, verified list of findings.
				const inventory = await sourceInventory(ctx.cwd, paths);
				const total = inventory.reduce((sum, item) => sum + item.bytes, 0);
				const shards = total > config.auditShardBytes ? packShards(inventory, config.auditShardBytes, config.auditMaxShards) : [];
				const jobs: ShardJob[] = shards.length > 1
					? shards.map((shard, index) => ({ paths: compressPaths(shard.map((item) => item.file), inventory.map((item) => item.file)), question: `Question: ${params.question}\nThis is part ${index + 1} of ${shards.length} of the audit (${Math.round(total / 1024)} KB of source in all): audit only the paths below; other consultants cover the rest. Note concerns that reach into other parts as Risk lines.` }))
					: [{ paths, question: `Question: ${params.question}` }];
				const audit = await runShardedReview(ctx, pool, "[READ-ONLY CODING CONSULTANT]\nPurpose: audit", jobs, signal, { requireVerdict: false, role: "consult", instructions: AUDIT_FORMAT, alternate: (params.reviewer ?? "auto") === "auto" });
				metrics.readOnlyConsultations += jobs.length;
				persist();
				updateStatus(ctx);
				return {
					content: [{ type: "text", text: truncateUtf8(`Audit (${profileName}${jobs.length > 1 ? `, ${jobs.length} parts, ${Math.round(total / 1024)} KB of source` : ""}). ${audit.text}`, config.maxOutputBytes) }],
					details: { purpose: params.purpose, paths, profile: profileName, parts: jobs.length, reviewers: audit.reviewers, violations: audit.violations },
					isError: audit.failed,
					usage: combineUsage(audit.usage),
				};
			}
			const outcome = await runConsultation(ctx, pool, `[READ-ONLY CODING CONSULTANT]\nPurpose: ${params.purpose}`, `Question: ${params.question}`, paths, signal, { findings: params.purpose === "implementation-review" || params.purpose === "risk-review" });
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

	pi.registerTool({
		name: "review_changes",
		label: "Review branch changes",
		description: "Independent read-only review of a branch, pull request or local work against a base ref, without loading the diff into your context: the extension takes the diff since the merge base, splits a large one into parts reviewed in parallel by Claude and GPT reviewers, gives them the code around each change and the uses of the declarations it touches, has MAJOR findings verified by a second model, and returns one merged list of findings. A later review of the same branch in this session checks the previous findings and reviews only what changed since. Use it instead of reading a branch diff yourself; then read only the ranges needed to act on the findings. Not for changes made by delegate_implementation, which are reviewed automatically.",
		parameters: Type.Object({
			base: Type.Optional(Type.String({ description: "Branch, tag or commit to compare with, e.g. origin/main. Default: the current branch's upstream, else origin/HEAD, main or master." })),
			paths: Type.Optional(Type.Array(Type.String({ description: "Repository-relative path to limit the review to" }), { minItems: 1 })),
			focus: Type.Optional(Type.String({ description: "Intent of the change (e.g. the PR description) and what matters most; reviewers judge the change against it." })),
			uncommitted: Type.Optional(Type.Boolean({ description: "Include uncommitted and untracked changes (default true); false reviews only the commits." })),
			full: Type.Optional(Type.Boolean({ description: "Review the whole branch again even when it was reviewed earlier in this session (default false: only the changes since that review, plus a check of its findings)." })),
			profile: Type.Optional(StringEnum(PROFILE_NAMES, { description: "Reviewer strength; default large." })),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			if (!enabled) throw new Error("SupervisedCoding is disabled. Run /SupervisedCoding on.");
			if (delegationRunning) throw new Error("Wait for the running delegation before reviewing changes.");
			if (!isAllowedSupervisor(ctx, config)) throw new Error("Only an active supervisor model may request reviews.");
			const paths = params.paths ? normalizeAllowedPaths(params.paths, true) : [];
			const { ref, mergeBase } = await resolveReviewBase(ctx.cwd, params.base);
			const uncommitted = params.uncommitted ?? true;
			const diff = await branchDiff(ctx.cwd, mergeBase, paths, uncommitted);
			const target = uncommitted ? "the working tree" : "HEAD";
			if (!diff.trim()) return { content: [{ type: "text", text: `No changes between ${ref} (merge base ${mergeBase.slice(0, 12)}) and ${target}${paths.length ? ` in ${paths.join(", ")}` : ""}.` }], details: { base: ref, mergeBase, files: 0, parts: 0 } };
			const branchFiles = splitDiff(diff).map((item) => item.file);
			// A branch reviewed earlier in this session: its unchanged code was reviewed already. The follow-up checks
			// the earlier findings and reviews what changed since, so fix-and-review rounds converge instead of
			// re-auditing the whole branch each time.
			const reviewKey = `${ctx.cwd}|${mergeBase}|${uncommitted}|${paths.join(",")}`;
			const prior = params.full ? undefined : branchReviews.get(reviewKey);
			let reviewed = diff;
			if (prior) {
				const delta = await changesSince(ctx.cwd, [...new Set([...prior.files, ...branchFiles])], prior.checkpoint, Number.MAX_SAFE_INTEGER);
				if (!delta.files.length) return { content: [{ type: "text", text: `No changes since review ${prior.count} of this branch; its findings stand:\n${prior.findings.join("\n") || "No findings."}` }], details: { base: ref, mergeBase, files: 0, parts: 0, followUp: true } };
				reviewed = delta.diff;
			}
			const fileDiffs = splitDiff(reviewed).map((item) => ({ ...item, bytes: Buffer.byteLength(item.text, "utf8") }));
			const shards = packShards(fileDiffs, config.maxDiffBytes, Number.MAX_SAFE_INTEGER);
			if (shards.length > config.reviewMaxShards) {
				// Too large for one call: say how it splits, so the supervisor reviews it in parts with paths.
				const byDir = new Map<string, { files: number; bytes: number }>();
				for (const item of fileDiffs) {
					const dir = item.file.includes("/") ? item.file.split("/").slice(0, item.file.split("/").length > 2 ? 2 : 1).join("/") : ".";
					const known = byDir.get(dir) ?? { files: 0, bytes: 0 };
					byDir.set(dir, { files: known.files + 1, bytes: known.bytes + item.bytes });
				}
				const rows = [...byDir].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 30).map(([dir, item]) => `- ${dir}: ${item.files} file(s), ${Math.round(item.bytes / 1024)} KB of diff`);
				throw new Error(`The change is too large for one review (${fileDiffs.length} files, ${Math.round(diff.length / 1024)} KB of diff: ${shards.length} parts, at most reviewMaxShards ${config.reviewMaxShards}). Review it in several calls with paths, e.g. by directory:\n${rows.join("\n")}`);
			}
			const focus = params.focus?.trim() ? `\nIntent and focus: ${params.focus.trim()}` : "";
			const scope = prior
				? `This branch (changes against ${ref}, merge base ${mergeBase.slice(0, 12)}) was reviewed before, and these findings were reported:\n${truncateUtf8(prior.findings.join("\n") || "No findings.", 6000)}\nThe changes below were made since that review. Say for each earlier finding in these files whether it is fixed (report it again if not), and review these changes for new defects. Code unchanged since that review was reviewed already: do not audit it again.`
				: `Review the changes against ${ref} (merge base ${mergeBase.slice(0, 12)}) up to ${target}.`;
			const jobs: ShardJob[] = [];
			for (const [index, shard] of shards.entries()) {
				const truncated = shard.length === 1 && shard[0].bytes > config.maxDiffBytes;
				const shardDiff = truncated ? `${truncateUtf8(shard[0].text, config.maxDiffBytes)}\n[Diff truncated at ${config.maxDiffBytes} bytes: read the file for the rest.]` : shard.map((item) => item.text.trimEnd()).join("\n");
				const files = shard.map((item) => item.file).filter((file) => fs.existsSync(path.join(ctx.cwd, file)));
				jobs.push({
					question: `${scope}${focus}${shards.length > 1 ? `\nThis is part ${index + 1} of ${shards.length}; other reviewers cover the other files: note concerns that reach into them as Risk lines.` : ""}\nLook for correctness bugs, regressions, callers the change breaks, unsafe behavior, type/API problems and missing or inadequate tests.`,
					paths: files.length ? files : shard.map((item) => item.file),
					diff: shardDiff,
					diffComplete: !truncated,
					material: await reviewMaterial(ctx.cwd, shardDiff, files, config),
				});
			}
			onUpdate?.({ content: [{ type: "text", text: `Reviewing ${fileDiffs.length} file(s) in ${jobs.length} part(s) against ${ref}` }], details: { running: true } });
			const profileName = params.profile ?? "large";
			delegationRunning = true;
			let review: Awaited<ReturnType<typeof runShardedReview>>;
			try {
				review = await runShardedReview(ctx, reviewPool([profileName, "large", "critical"]), "[INDEPENDENT READ-ONLY CODE REVIEW OF BRANCH CHANGES]", jobs, signal, { requireVerdict: true, role: "review", maxTurns: config.workerMaxTurns[profileName], diffLabel: prior ? `made since review ${prior.count} of this branch` : `since ${ref}` });
			} finally {
				delegationRunning = false;
			}
			metrics.readOnlyConsultations += jobs.length;
			const count = (branchReviews.get(reviewKey)?.count ?? 0) + 1;
			if (!review.failed) {
				branchReviews.delete(reviewKey);
				branchReviews.set(reviewKey, { checkpoint: await checkpoint(ctx.cwd, branchFiles), files: branchFiles, findings: review.findings.map((finding) => formatFinding(finding)), count });
				// Checkpoints hold file contents: keep only the most recent branches.
				while (branchReviews.size > 4) branchReviews.delete(branchReviews.keys().next().value!);
			}
			persist();
			updateStatus(ctx);
			const heading = prior
				? `Follow-up review ${count} of the changes since ${ref}: the earlier findings and the ${fileDiffs.length} file(s) changed since review ${prior.count} (full: true reviews the whole branch).`
				: `Changes since ${ref} (merge base ${mergeBase.slice(0, 12)}) up to ${target}: ${fileDiffs.length} file(s).`;
			// Every round finds something new when reviewers dig deeper each time: past the second, the user decides.
			const convergence = count >= 3 ? `\n\nCONVERGENCE: this branch has now been reviewed ${count} times in this session. Fix only findings that are defects of the requested change; report the rest to the user and ask before another fix-and-review round.` : "";
			return {
				content: [{ type: "text", text: truncateUtf8(`${heading}\n${review.text}${convergence}`, config.maxOutputBytes) }],
				details: { base: ref, mergeBase, files: fileDiffs.length, parts: jobs.length, verdict: review.verdict, reviewers: review.reviewers, violations: review.violations, followUp: Boolean(prior), reviewCount: count },
				isError: review.failed,
				usage: combineUsage(review.usage),
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
			const reviewPaths = changes.complete ? changes.files : start.paths;
			review = await runConsultation(ctx, reviewOrder(task.implementer, profile), "[INDEPENDENT READ-ONLY CODE REVIEW OF THE WHOLE TASK]", question, reviewPaths, signal, { diff: changes.diff, diffComplete: changes.complete, diffLabel: "made by the whole task", requireVerdict: true, findings: true, role: "review", maxTurns: config.workerMaxTurns[profile], material: await reviewMaterial(ctx.cwd, changes.diff, reviewPaths, config) });
		} finally {
			delegationRunning = false;
		}
		if (review.verdict !== "none") metrics.reviewVerdicts[review.verdict] = (metrics.reviewVerdicts[review.verdict] ?? 0) + 1;
		persist();
		if (review.reviewer && !review.failed) return { text: `Review of the whole task (${review.reviewer}), verdict ${review.verdict.toUpperCase()}:\n${truncateUtf8Middle(review.text, config.outputLimits.consultBytes)}`, verdict: review.verdict };
		return { text: `REVIEW OF THE WHOLE TASK UNAVAILABLE: ${review.text}${review.violations.length ? `\nREAD-ONLY VIOLATION: ${review.violations.join("; ")}` : ""}`, verdict: "none" };
	}

	// ── Sharded reviews and audits ─────────────────────────────────────────────────────────────────

	/** One part of a review or audit, reviewed by its own read-only consultant. */
	interface ShardJob {
		question: string;
		paths: string[];
		diff?: string;
		diffComplete?: boolean;
		material?: ReviewMaterial;
	}

	/**
	 * Reviewer order for part `index`: with several parts, the families take turns going first, so a large change
	 * gets both families' eyes and no single provider carries all the load. Quality order holds within a family.
	 */
	function shardOrder(pool: WorkerCandidate[], index: number, parts: number): WorkerCandidate[] {
		const families = [...new Set(pool.map(modelFamily))];
		if (parts < 2 || families.length < 2) return pool;
		const wanted = families[index % families.length];
		return [...pool].sort((a, b) => Number(modelFamily(b) === wanted) - Number(modelFamily(a) === wanted));
	}

	/** Code cited by findings: the declaration around each line (up to 120 lines), else 25 lines around it. */
	function citedCode(cwd: string, findings: Finding[], maxBytes: number): string {
		const byFile = new Map<string, number[]>();
		for (const finding of findings) if (finding.file && finding.line) byFile.set(finding.file, [...(byFile.get(finding.file) ?? []), finding.line]);
		const blocks: string[] = [];
		let used = 0;
		for (const [file, lines] of byFile) {
			let source: string;
			try { source = fs.readFileSync(path.join(cwd, file), "utf8"); } catch { continue; }
			const total = source.split(/\r?\n/).length;
			const entries = outlineSupported(file) ? outlineSource(file, source) : [];
			const ranges = lines.map((line): [number, number] => {
				const around = entries.filter((entry) => entry.line <= line && line <= entry.end && entry.end - entry.line < 120).sort((a, b) => (b.end - b.line) - (a.end - a.line))[0];
				return around ? [around.line, around.end] : [Math.max(1, line - 25), Math.min(total, line + 25)];
			}).sort((a, b) => a[0] - b[0]);
			const merged: Array<[number, number]> = [];
			for (const range of ranges) {
				const last = merged.at(-1);
				if (last && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1]);
				else merged.push([...range]);
			}
			const block = renderRanges(file, source, merged);
			if (used + Buffer.byteLength(block, "utf8") > maxBytes) continue;
			blocks.push(block);
			used += Buffer.byteLength(block, "utf8");
		}
		return blocks.join("\n\n");
	}

	/**
	 * A second reviewer, of another family than the one that reported them where possible, checks MAJOR findings
	 * against the code. Rejected ones are set apart (still listed, so the supervisor can overrule the verifier);
	 * confirmed ones are marked; the rest stay unverified.
	 */
	async function verifyFindings(ctx: ExtensionContext, findings: Finding[], pool: WorkerCandidate[], reporterFamilies: string[], signal: AbortSignal | undefined): Promise<{ kept: Finding[]; rejected: string[]; note: string; usage: Array<Usage | undefined> }> {
		const majors = findings.filter((finding) => finding.severity === "MAJOR");
		if (!majors.length) return { kept: findings, rejected: [], note: "", usage: [] };
		const checked = majors.slice(0, 15);
		const families = [...new Set(reporterFamilies)];
		const order = families.length === 1 ? [...pool].sort((a, b) => Number(modelFamily(a) === families[0]) - Number(modelFamily(b) === families[0])) : pool;
		const cited = citedCode(ctx.cwd, checked, 40_000);
		const outcome = await runConsultation(ctx, order, "[READ-ONLY VERIFICATION OF REVIEW FINDINGS]", `Independent reviewers reported the MAJOR defects below. Check each one against the code: the cited code is below; read more only when needed.\n${checked.map((finding, index) => formatFinding(finding, index + 1)).join("\n")}`, [...new Set(checked.map((finding) => finding.file).filter(Boolean))], signal, {
			role: "review",
			instructions: "Answer with exactly one line per finding and nothing else: `#<n> CONFIRMED — reason` when the defect is real and material (wrong results, crashes, data loss, unsafe behavior or broken callers in realistic use), `#<n> MINOR — reason` when it is real but not material, `#<n> REJECTED — evidence` when the code does not have it, `#<n> UNSURE — what is missing` otherwise.",
			material: { context: cited ? `CITED CODE (current content, numbered)\n${cited}` : "", apiContext: "", apiFiles: "", apiWhole: false },
		});
		if (outcome.failed) return { kept: findings, rejected: [], note: `Verification of MAJOR findings unavailable: ${outcome.text.slice(0, 200)}`, usage: outcome.usage };
		const statuses = parseVerification(outcome.text);
		const rejected: string[] = [];
		const kept = findings.filter((finding) => {
			const index = checked.indexOf(finding);
			if (index < 0) return true;
			const status = statuses.get(index + 1);
			if (status?.status === "rejected") {
				rejected.push(`${formatFinding(finding)} — rejected: ${status.reason || "no reason given"}`);
				return false;
			}
			if (status?.status === "minor") {
				finding.severity = "MINOR";
				finding.status = "downgraded";
			} else {
				finding.status = status?.status === "confirmed" ? "confirmed" : "unverified";
			}
			return true;
		});
		// Downgraded findings join the MINOR ones.
		kept.sort((a, b) => Number(a.severity === "MINOR") - Number(b.severity === "MINOR"));
		return { kept, rejected, note: `MAJOR findings verified by ${outcome.reviewer}.`, usage: outcome.usage };
	}

	/**
	 * Runs the parts in parallel (reviewConcurrency at a time), merges their findings, verifies the MAJOR ones and
	 * returns one consolidated report: the supervisor sees findings, not the reviewers' transcripts.
	 */
	async function runShardedReview(ctx: ExtensionContext, pool: WorkerCandidate[], header: string, jobs: ShardJob[], signal: AbortSignal | undefined, options: { requireVerdict: boolean; maxTurns?: number; role: UsageRole; diffLabel?: string; instructions?: string; alternate?: boolean }): Promise<{ text: string; verdict: ReviewVerdict; failed: boolean; usage: Array<Usage | undefined>; violations: string[]; reviewers: string[]; findings: Finding[] }> {
		const outcomes = await mapLimit(jobs, config.reviewConcurrency, (job, index) => runConsultation(ctx, options.alternate === false ? pool : shardOrder(pool, index, jobs.length), header, job.question, job.paths, signal, { diff: job.diff, diffComplete: job.diffComplete, diffLabel: options.diffLabel, requireVerdict: options.requireVerdict, findings: true, instructions: options.instructions, role: options.role, maxTurns: options.maxTurns, material: job.material }));
		const usage = outcomes.flatMap((outcome) => outcome.usage);
		const violations = [...new Set(outcomes.flatMap((outcome) => outcome.violations))];
		const lists: Finding[][] = [];
		const risks = new Set<string>();
		const notes: string[] = [];
		const unavailable: string[] = [];
		const reporterFamilies: string[] = [];
		let unparsedMajor = false;
		let anyMinor = false;
		outcomes.forEach((outcome, index) => {
			const part = jobs.length > 1 ? `Part ${index + 1}/${jobs.length} (${jobs[index].paths.slice(0, 4).join(", ")}${jobs[index].paths.length > 4 ? ", …" : ""})` : "Review";
			if (outcome.failed || !outcome.reviewer) {
				unavailable.push(`${part}: ${outcome.text.slice(0, 300)}`);
				return;
			}
			const parsed = parseFindings(outcome.text, outcome.reviewer);
			lists.push(parsed.findings);
			parsed.risks.forEach((risk) => risks.add(risk));
			const family = pool.find((item) => candidateLabel(item) === outcome.reviewer);
			if (parsed.findings.some((finding) => finding.severity === "MAJOR") && family) reporterFamilies.push(modelFamily(family));
			if (outcome.verdict === "minor" || outcome.verdict === "major") anyMinor = true;
			// A reviewer that ignored the format still reported something: keep its words rather than lose them.
			if (!parsed.findings.length && (outcome.verdict === "minor" || outcome.verdict === "major" || !options.requireVerdict) && parsed.other.length) {
				if (outcome.verdict === "major") unparsedMajor = true;
				notes.push(`${part} — ${outcome.reviewer}:\n${truncateUtf8Middle(parsed.other.join("\n"), Math.max(3000, Math.floor(config.outputLimits.consultBytes / jobs.length)))}`);
			}
		});
		const verified = await verifyFindings(ctx, mergeFindings(lists), pool, reporterFamilies, signal);
		usage.push(...verified.usage);
		const findings = verified.kept;
		const majors = findings.filter((finding) => finding.severity === "MAJOR").length;
		const verdict: ReviewVerdict = unavailable.length === jobs.length ? "none" : majors || unparsedMajor ? "major" : findings.length || anyMinor ? "minor" : "pass";
		const reviewers = [...new Set(outcomes.map((outcome) => outcome.reviewer).filter((item): item is string => Boolean(item)))];
		const text = [
			`${jobs.length > 1 ? `${jobs.length} parts reviewed in parallel` : "Reviewed"} by ${reviewers.join(", ") || "no reviewer"}. ${options.requireVerdict ? `Verdict: ${verdict.toUpperCase()}` : `${findings.length} finding(s)`}${unavailable.length && unavailable.length < jobs.length ? " (INCOMPLETE: some parts were not reviewed)" : ""}.${verified.note ? ` ${verified.note}` : ""}`,
			findings.length ? `Findings (${majors} MAJOR, ${findings.length - majors} MINOR):\n${findings.map((finding) => formatFinding(finding)).join("\n")}` : "No findings.",
			verified.rejected.length ? `Rejected by verification (overrule only with evidence):\n${verified.rejected.join("\n")}` : "",
			notes.length ? `Notes:\n${notes.join("\n\n")}` : "",
			risks.size ? `Risks:\n${[...risks].slice(0, 8).map((risk) => `- ${risk}`).join("\n")}` : "",
			unavailable.length ? `NOT REVIEWED:\n${unavailable.join("\n")}` : "",
			violations.length ? `READ-ONLY VIOLATION: ${violations.join("; ")}` : "",
		].filter(Boolean).join("\n\n");
		return { text: truncateUtf8Middle(text, config.outputLimits.consultBytes), verdict, failed: unavailable.length > 0 || violations.length > 0, usage, violations, reviewers, findings };
	}

	/**
	 * Whether a delegation costs more than the change it carries. A worker re-reads its whole context on every turn, so
	 * starting one has a floor of its own (measured by cheapestDelegationTokens) that a few lines of mechanical work can
	 * never repay: the supervisor has edit/write for exactly this case. Deliberately a narrow conjunction, because the
	 * one thing the extension cannot see is what the supervisor already holds in context, which is what really decides
	 * the trade: a single small or not-yet-created target, one authorized path, a mechanical or documentation change at
	 * the small profile, no symbols to study, and no session to continue. Everything else is left to the supervisor.
	 */
	function tinyDelegation(cwd: string, assessment: TaskAssessment | undefined, profile: ExecutionProfileName, allowedPaths: string[], guide: string, continuePrevious: boolean): { bytes: number; path: string } | undefined {
		if (!config.tinyDelegationBytes || continuePrevious || profile !== "small" || allowedPaths.length !== 1) return undefined;
		if (!assessment || !["mechanical", "docs"].includes(assessment.kind) || assessment.risk !== "low" || assessment.scope !== "local") return undefined;
		// The guide as the supervisor wrote it: validateImplementationGuide adds a SYMBOLS line of its own when the
		// section is missing, and reading that back would make "no symbols to study" impossible to satisfy.
		if (namedSymbols(guide)) return undefined;
		const target = path.resolve(cwd, allowedPaths[0]);
		let bytes = 0;
		try {
			const stat = fs.statSync(target);
			// A directory is never one small change, whatever its size.
			if (stat.isDirectory()) return undefined;
			bytes = stat.size;
		} catch {
			bytes = 0; // Not created yet: a new short file is the cheapest case of all.
		}
		return bytes <= config.tinyDelegationBytes ? { bytes, path: allowedPaths[0] } : undefined;
	}

	/**
	 * The consequential kind the authorized paths themselves suggest. Matching is on whole path segments and on the file
	 * extension, never on substrings, so "author.ts" is not authentication while "db/migrations/003.sql" is a migration.
	 * It reports what the paths look like; it never decides the profile on its own.
	 */
	function sensitiveKind(allowedPaths: string[]): { kind: string; path: string } | undefined {
		for (const item of allowedPaths) {
			const normalized = item.replace(/\\/g, "/").toLowerCase();
			const segments = normalized.split("/").filter(Boolean);
			const extension = path.extname(normalized);
			for (const [kind, rule] of Object.entries(config.sensitivePaths)) {
				if (segments.some((segment) => rule.segments.includes(segment)) || (extension && rule.extensions.includes(extension))) return { kind, path: item };
			}
		}
		return undefined;
	}

	/** Whether a guide names symbols to study: its SYMBOLS section exists and says more than "none". */
	function namedSymbols(guide: string): boolean {
		const lines = guide.split(/\r?\n/);
		const start = lines.findIndex((line) => /^\s*(?:#{1,6}\s*)?\**\s*SYMBOLS?\s*\**\s*:/i.test(line));
		if (start < 0) return false;
		const body = [lines[start].replace(/^[^:]*:/, "")];
		for (const line of lines.slice(start + 1)) {
			if (/^\s*(?:#{1,6}\s*)?\**\s*[A-Z][A-Z /]*\s*\**\s*:/.test(line)) break;
			body.push(line);
		}
		const text = body.join(" ").replace(/^\s*[-*•]\s*/gm, "").trim();
		return Boolean(text) && !/^(?:(?:none|n\/a|na|nothing)\b|[-–—]\s*$)/i.test(text);
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
			const declared = params.assessment ?? (belongsToTask ? previousTask?.assessment : undefined);
			// The authorized paths corroborate the declared scope: several files are multi-file work whatever the guide
			// says, so an optimistic assessment cannot walk under the profile floor. It only ever raises, like the floors.
			// An omitted assessment, or an omitted scope, is the default scope ("local"): both must be corroborated, or
			// the floor is skipped by saying nothing. One authorized directory is breadth too, whatever it holds today.
			const breadth = allowedPaths.length > 1 || allowedPaths.some((item) => {
				try {
					return fs.statSync(path.resolve(ctx.cwd, item)).isDirectory();
				} catch {
					return false;
				}
			});
			const observed = breadth && (declared?.scope ?? "local") === "local" ? { ...declared, scope: "multi-file" as const } : declared;
			const assessed = assessTask(params.profile ?? (belongsToTask ? previousTask?.profile : undefined) ?? config.defaultExecutionProfile, observed);
			const profileName = assessed.profile;
			const { guide: implementationGuide } = validateImplementationGuide(params.implementationGuide, allowedPaths, config.minImplementationGuideChars[profileName]);
			// A consequential path declared as low risk is questioned once. The extension does not raise the profile by
			// itself here, because only the supervisor knows whether this particular change touches the consequential part;
			// it just refuses to take "low risk" on such a path without the supervisor saying so deliberately.
			const suspected = sensitiveKind(allowedPaths);
			const questionKey = `${taskPacket?.id ?? "none"}:${allowedPaths.join(",")}`;
			// Not conditioned on the declared risk: an omitted assessment defaults to medium risk, which would have let
			// exactly the optimistic case through. Below critical, and not already declared consequential, is enough.
			if (suspected && profileName !== "critical" && !["security", "concurrency", "migration"].includes(assessed.assessment.kind) && !assessmentQuestioned.has(questionKey)) {
				assessmentQuestioned.add(questionKey);
				return {
					content: [{ type: "text", text: `Delegation not started: the assessment looks optimistic for these paths.\n${suspected.path} reads as ${suspected.kind} work, while the assessment says kind ${assessed.assessment.kind} with risk ${assessed.assessment.risk}, which keeps this task at the ${profileName} profile. Judge it again: if this change really touches ${suspected.kind}-sensitive behaviour, say so through kind and risk, because that decides the profile, the reviewer and the effort. If it does not, and the path only happens to be named that way, delegate again with the assessment you stand behind and it will run.` }],
					details: { profile: profileName, taskPacketId: taskPacket?.id, delegated: false, reason: "optimistic assessment on sensitive paths", suspectedKind: suspected.kind, path: suspected.path },
					isError: true,
				};
			}
			const tiny = params.delegateAnyway ? undefined : tinyDelegation(ctx.cwd, assessed.assessment, profileName, allowedPaths, params.implementationGuide, Boolean(params.continuePrevious));
			if (tiny) {
				learning = loadLearning(learningPath);
				const floor = cheapestDelegationTokens(learning.outcomes, await repoKey(ctx.cwd));
				const cost = floor ? `The cheapest delegation recorded in this repository still cost ${floor.toLocaleString("en-US")} tokens` : "A delegation costs on the order of 100k tokens before it changes a line";
				const size = tiny.bytes ? `${tiny.bytes} bytes` : "a file that does not exist yet";
				return {
					content: [{ type: "text", text: `Delegation not started: it would cost more than the change.\n${cost}, because a worker re-reads its whole context on every one of its turns. This one is a ${assessed.assessment.kind} change to ${tiny.path} (${size}), at the small profile, with no symbols to study.\n\nMake it yourself with edit/write, run the project's checks with run_verification, then complete_task. If it really needs a worker — unfamiliar code, dependencies you cannot see from here — call again with delegateAnyway: true.` }],
					details: { profile: profileName, taskPacketId: taskPacket?.id, delegated: false, reason: "smaller than a delegation", target: tiny.path, targetBytes: tiny.bytes, measuredFloorTokens: floor ?? null },
					isError: true,
				};
			}
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
				// So do checks that could not start after an earlier worker, until they pass.
				launchFailedChecks: open?.launchFailedChecks,
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
				const codeMap = config.workerCodeMapBytes > 0 ? await workerCodeMap(ctx.cwd, allowedPaths, implementationGuide, config.workerCodeMapBytes) : "";
				/** Allowlisted-looking VERIFY commands that are unsafe or malformed: reported, never run. */
				const rejectedVerify: string[] = [];
				const verifyCommands = config.autoVerify ? dedupeVerifyCommands(ctx.cwd, extractVerifyCommands(implementationGuide, config.verificationCommands, UNSAFE_COMMAND_CHARS, rejectedVerify)) : [];
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
				// Checks that could not start say nothing about the code: never a baseline, never a correction round.
				const launchFailures = new Set<string>();
				const launchFailureCommands = new Set<string>();
				const collect = (check: CheckResult) => {
					check.changed.forEach((file) => checkChanges.add(file));
					check.safetyViolations.forEach((item) => checkSafety.add(`${check.command}: ${item}`));
					if (check.launchError) { launchFailures.add(`${check.command}: ${check.launchError}`); launchFailureCommands.add(check.command); }
				};
				for (const command of verifyCommands) {
					const check = await runCheck(ctx, command, signal, true);
					collect(check);
					if (check.reused) reusedAtStart.push(command);
					if (check.safetyViolations.length || check.launchError) break;
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
				// A check that cannot start could only ever be recorded as "failing since the start": stop before any worker.
				if (launchFailures.size) {
					const report = `DELEGATION BLOCKED before any worker started: a verification command could not be started, so the task start could not be checked.\nVERIFICATION NOT STARTED: ${[...launchFailures].join("; ")}.\nNo baseline was recorded. Fix the VERIFY command or make its executable available (verification runs without a shell) before delegating again.`;
					metrics.failedDelegations++;
					// No worker ran, so a task already implemented or failed by checks alone stays checks-only: a later
					// passing run_verification (once the command launches again) still clears it, same as any other launch failure.
					// A fresh task blocked on its first delegation has no worker run to call "the only failure": never restorable this way.
					const onlyChecksSoFar = open?.phase === "implemented" || (open?.phase === "failed" && open?.failedChecks !== undefined);
					updateTaskPacket({
						phase: "failed",
						verification: "failed",
						failedChecks: onlyChecksSoFar ? [...new Set([...(open?.failedChecks ?? []), ...(taskPacket.failedChecks ?? []), ...launchFailureCommands])] : undefined,
						launchFailedChecks: onlyChecksSoFar ? [...new Set([...(open?.launchFailedChecks ?? []), ...(taskPacket.launchFailedChecks ?? []), ...launchFailureCommands])] : taskPacket.launchFailedChecks,
						lastReport: report,
					});
					updateStatus(ctx);
					return {
						content: [{ type: "text", text: truncateUtf8(report, config.maxOutputBytes) }],
						details: { attempts: [], profile: profileName, taskPacketId: taskPacket?.id, verification: "failed", verificationLaunchFailures: [...launchFailures], verificationSafetyViolations: [], verificationChanged: [...checkChanges], scopeViolations: [], correctionRounds: 0, reviewVerdict: "none", sessionPreserved: Boolean(workerSession && workerSession.taskId === taskPacket?.id), workerStarted: false },
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
				const spec: ImplementationSpec = { task: params.recoveryNote ? `${params.task}\n\n${params.recoveryNote}` : params.task, guide: implementationGuide, criteria, allowedPaths, profileName, assessment: assessed.assessment, preferWorker: params.preferWorker, effort: params.effort, resumeSessionId, resumeWorker: workerSession?.worker ?? "claude", resumeModel: workerSession?.model, repoContext, codeMap, checkpoint: beforeContent, verificationCommands: verifyCommands };
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
				/** The last automatic check run, on the final code. */
				let finalChecks: CheckResult[] = [];
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
					// Nor for a check that could not start: no code change can be judged by it.
					while (regressions.length && !checkSafety.size && !launchFailures.size && correctionRounds < config.maxCorrectionRounds) {
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
					if (launchFailures.size) {
						verification = "failed";
						failed = true;
						notes.push(`VERIFICATION NOT STARTED: ${[...launchFailures].join("; ")}. No correction round for it; fix the command or its executable, then run_verification.`);
					}
					if (checkChanges.size) notes.push(`Warning: verification commands changed files (not counted as scope violations of the worker): ${[...checkChanges].join(", ")}`);
					ranCommands = checks.map((check) => check.command);
					finalChecks = checks;
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
				// Checks that could not start after a worker keep the task failed until the same command passes: earlier
				// delegations' ones stay, whatever this one ran (no VERIFY, other commands, an unchanged failure), unless
				// its final checks passed them. This delegation's own outcome (learning, review) is not affected.
				const notStarted = regressions.filter((check) => check.launchError).map((check) => check.command);
				const passedNow = new Set(finalChecks.filter((check) => check.ok && !check.safetyViolations.length).map((check) => check.command));
				const heldBack = (taskPacket?.launchFailedChecks ?? []).filter((command) => !passedNow.has(command) && !notStarted.includes(command));
				const launchBlockers = [...notStarted, ...heldBack];
				// Only a task failed by its checks alone can be restored by passing checks (run_verification).
				const onlyChecksFailed = (regressions.length > 0 || launchBlockers.length > 0) && !outcome.failed && !correctionFailed && !limitReached && !scopeViolations.length && !checkSafety.size;
				updateTaskPacket({
					phase: failed || launchBlockers.length ? "failed" : "implemented",
					primaryWorker: candidateLabel(implementer),
					implementer,
					lastReport: report,
					verification: launchBlockers.length ? "failed" : verification,
					failedChecks: onlyChecksFailed ? [...new Set([...regressions.map((check) => check.command), ...launchBlockers])] : undefined,
					launchFailedChecks: launchBlockers.length ? launchBlockers : undefined,
				});

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
					const reviewTargets = changes.complete ? reviewPaths : allowedPaths;
					const review = await runConsultation(ctx, reviewOrder(implementer, profileName), "[INDEPENDENT READ-ONLY CODE REVIEW]", question, reviewTargets, signal, { diff: changes.diff, diffComplete: changes.complete, requireVerdict: true, findings: true, role: "review", maxTurns: config.workerMaxTurns[profileName], material: await reviewMaterial(ctx.cwd, changes.diff, reviewTargets, config) });
					usage.push(...review.usage);
					reviewVerdict = review.verdict;
					reviewText = review.reviewer && !review.failed
						? `Independent review (${review.reviewer}), verdict ${reviewVerdict.toUpperCase()}:\n${review.text}`
						: `INDEPENDENT REVIEW UNAVAILABLE: ${review.text}${review.violations.length ? `\nREAD-ONLY VIOLATION: ${review.violations.join("; ")}` : ""}\nReview the diff yourself before accepting.`;
					if (review.violations.length || reviewVerdict === "major") failed = true;
					// The first delegation's diff is the whole task so far; later ones cover only their own delta.
					// The review ran only on a delegation that had not failed: failing now, it failed the task for more than its
					// checks, so passing checks can no longer restore it.
					updateTaskPacket({ phase: failed || launchBlockers.length ? "failed" : "implemented", lastReport: `${report}\n\n${reviewText}`, reviewVerdict, reviewScope: taskPacket.delegationCount === 1 ? "task" : "delegation", ...(failed ? { failedChecks: undefined } : {}) });
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
				const changedFiles = afterAll.available ? filesChangedBetween(outcome.before, afterAll) : [];
				const changedLine = afterAll.available ? `Changed files in this delegation: ${changedFiles.join(", ") || "none"}\n` : "Git unavailable: scope enforcement degraded outside Git repositories.\n";
				// The supervisor reviews the change right here instead of spending extra turns on supervisor_git.
				const delta = afterAll.available ? await changesSince(ctx.cwd, allowedPaths, beforeContent, RESULT_DIFF_BYTES) : undefined;
				const diffSection = delta?.complete ? `DIFF (this delegation only)\n\`\`\`diff\n${delta.diff}\n\`\`\`` : delta ? `DIFF: incomplete; inspect with supervisor_git. Changed paths: ${delta.files.join(", ")}.` : "";
				const verificationLine = verifyCommands.length
					? `Automatic verification: ${verification}${correctionRounds ? ` after ${correctionRounds} correction round(s)` : ""} — already run by the extension on the final code: ${ranCommands.join(", ")}. Do not re-run these; use run_verification only for other checks.\n`
					: "Automatic verification: none (no allowlisted command in VERIFY); run_verification before accepting.\n";
				const rejectedLine = rejectedVerify.length ? `VERIFY commands rejected, not run (verification runs without a shell): ${rejectedVerify.join("; ")}.\n` : "";
				const heldBackLine = heldBack.length ? `TASK STILL FAILED: ${heldBack.join(", ")} could not start after an earlier delegation and has not passed since; only a passing run of the same command (run_verification) clears it.\n` : "";
				// Each part has its own cap, so a long worker report can never push the review or the diff out of the result.
				const sections = [
					`${candidateLabel(implementer)} (${profileName}) ${limitReached ? "stopped" : failed ? "failed" : "completed"}.\n${limitReached ? `STOPPED: ${limitReached} reached. Partial work${workerSession ? " and the worker session are" : " is"} preserved; delegate the rest with continuePrevious=true.\n` : ""}${safetyLine}${changedLine}${verificationLine}${rejectedLine}${heldBackLine}${usageLine}`,
					truncateUtf8Middle(outcome.primaryOutput, config.outputLimits.workerReportBytes),
					verificationText,
					truncateUtf8Middle(reviewText, config.outputLimits.consultBytes),
					learningNotes.length ? `Learning: ${learningNotes.join("; ")}` : "",
				];
				const withoutDiff = Buffer.byteLength(sections.join("\n\n"), "utf8");
				// A diff is useful only whole: when it does not fit, point to it instead of cutting it.
				const tooLong = withoutDiff + Buffer.byteLength(diffSection, "utf8") + 2 > config.maxOutputBytes;
				const diffFits = Boolean(delta?.complete) && !tooLong;
				sections.splice(4, 0, diffSection && tooLong && delta
					? `DIFF: omitted to keep this result within maxOutputBytes; inspect with supervisor_git. Changed paths: ${delta.files.join(", ")}.`
					: diffSection);
				// The result shows the change whole: while nothing changes, supervisor_git need not send it again. Only
				// for files clean before the delegation, where git diff and the delegation's diff are the same change.
				for (const file of changedFiles) {
					if (diffFits && !outcome.before.changedFiles.includes(file)) shownDiffs.set(file, fileFingerprint(ctx.cwd, file));
					else shownDiffs.delete(file);
				}
				const text = truncateUtf8(sections.filter(Boolean).join("\n\n"), config.maxOutputBytes);
				return {
					content: [{ type: "text", text }],
					details: { attempts: outcome.attempts, implementer, changedFiles, before: outcome.before, after: afterAll, scopeViolations, verificationChanged: [...checkChanges], verificationSafetyViolations: [...checkSafety], verificationCommandsRun: verification === "unverified" ? [] : ranCommands, checksReusedAtStart: reusedAtStart, profile: profileName, resumed: outcome.resumed, taskPacketId: taskPacket?.id, verification, correctionRounds, reviewVerdict, limitReached, sessionPreserved: Boolean(workerSession && workerSession.taskId === taskPacket?.id) },
					isError: failed || launchBlockers.length > 0,
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
			delegateAnyway: Type.Optional(Type.Boolean({ description: "Only after the extension refused a delegation as smaller than its own cost: true states that this change really needs a worker (unfamiliar code, hidden dependencies) even though it looks small." })),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			return executeDelegation(params, signal, onUpdate, ctx);
		},
	});

	pi.registerTool({
		name: "run_verification",
		label: "Run verification",
		description: "Run one allowlisted verification missing from automatic VERIFY, or invalidated by subsequent changes. Do not repeat checks already run on the same final code. Returns the end of long output and warns about file changes. Runs without a shell: shell operators are rejected; quote arguments that contain spaces.",
		parameters: Type.Object({
			command: Type.String({ description: `Must start, argument by argument, with one of: ${config.verificationCommands.join(", ")}` }),
		}),
		async execute(_id, params, signal, _update, ctx) {
			if (!enabled) throw new Error("SupervisedCoding is disabled. Run /SupervisedCoding on.");
			if (delegationRunning) throw new Error("Wait for the running delegation before starting another verification.");
			// Same parser and allowlist as VERIFY; the canonical text keys baselines, failed checks and reuse.
			const { command } = verificationCommand(params.command, config.verificationCommands);
			const check = await runCheck(ctx, command, signal);
			// Nothing ran: no result for the task, whatever its state.
			if (check.launchError) throw new Error(`run_verification could not start ${command}: ${check.launchError}. Nothing was recorded for the task.`);
			// Recorded with the tree it ran on, whatever reuse is configured: this is the only evidence a change the
			// supervisor made itself can be accepted on, and it must not disappear when the check leaves files behind.
			ownChecks.push({ cwd: ctx.cwd, promptSeq, fingerprint: await workingTreeFingerprint(ctx.cwd), command, ok: check.ok });
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
				// Branch, HEAD or index changes are never cleared by a later passing check. Checks that could not start
				// stay too: they belong to the task.
				updateTaskPacket({ verification: "failed", phase: "failed", failedChecks: undefined });
			} else if (open && (state === "regression" || state === "changed")) {
				// Checks stay the only failure of a task that was implemented, or already failed by checks alone.
				const onlyChecks = open.phase === "implemented" || (open.phase === "failed" && open.failedChecks !== undefined);
				updateTaskPacket({ verification: "failed", phase: "failed", failedChecks: onlyChecks ? [...new Set([...(open.failedChecks ?? []), command])] : undefined });
			} else if (open && (state === "pass" || (state === "unchanged" && !open.launchFailedChecks?.includes(command))) && open.phase === "failed" && open.verification === "failed" && open.reviewVerdict !== "major" && open.failedChecks?.includes(command)) {
				// A check that failed the task is cleared once it passes, or fails again only the way it did at the task
				// start (the added failure was fixed). A check that could not start after the worker is cleared only by
				// passing. The task returns to implemented when none is left; other failures (a MAJOR review among them)
				// never clear.
				const notStarted = (open.launchFailedChecks ?? []).filter((item) => item !== command);
				const remaining = [...new Set([...open.failedChecks.filter((item) => item !== command), ...notStarted])];
				updateTaskPacket(remaining.length
					? { failedChecks: remaining, launchFailedChecks: notStarted.length ? notStarted : undefined }
					: { verification: state === "unchanged" ? "unchanged_failures" : "passed", phase: "implemented", failedChecks: undefined, launchFailedChecks: undefined });
			} else if (open && state === "pass" && open.launchFailedChecks?.includes(command)) {
				// It passes now: no longer a blocker, though the task stays failed for whatever else failed it.
				const notStarted = open.launchFailedChecks.filter((item) => item !== command);
				updateTaskPacket({ launchFailedChecks: notStarted.length ? notStarted : undefined });
			} else if (open && state === "pass" && open.phase === "implemented" && open.verification === "unverified") {
				updateTaskPacket({ verification: "passed" });
			}
			const status = check.timedOut ? `timed out after ${config.verificationTimeoutMinutes} min` : `exit code ${check.exitCode}`;
			const stillBlocking = state === "unchanged" && Boolean(taskPacket?.launchFailedChecks?.includes(command));
			const stateLine = state && state !== "pass" ? `\n${CHECK_STATE_TEXT[state]}${stillBlocking ? "\nStill failing the task: this check could not start after the worker, so only a passing run clears it." : ""}` : "";
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
			if (params.action === "diff" && (params.unifiedLines ?? 3) <= 5 && shownDiffs.size) {
				// Asking again for a diff a delegation result already showed whole costs its size once more.
				const [names, staged, untracked] = await Promise.all([
					gitStdout(ctx.cwd, ["diff", "--name-only", "--relative", "-z", ...pathArgs]),
					gitStdout(ctx.cwd, ["diff", "--cached", "--name-only", "--relative", "-z", ...pathArgs]),
					gitStdout(ctx.cwd, ["ls-files", "--others", "--exclude-standard", "-z", ...pathArgs]),
				]);
				const files = [...nulSeparated(names), ...nulSeparated(untracked)];
				if (files.length && !nulSeparated(staged).length && files.every((file) => shownDiffs.get(file) === fileFingerprint(ctx.cwd, file))) {
					return {
						content: [{ type: "text", text: `No change since the delegation results of this task: their DIFF sections already show these changes whole (${files.join(", ")}). For more context read the ranges you need, or ask again with unifiedLines above 5.` }],
						details: { action: params.action, paths, unifiedLines: params.unifiedLines ?? 3, outputBytes: 0, alreadyShown: true },
					};
				}
			}
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
				content: "[SUPERVISED CODING]\nGoal: correct, well-made code with as few defects as possible. Quality always beats speed; save tokens only where quality is not affected.\nRoles: you explore, plan, delegate, verify and accept. Workers implement. The extension picks worker models and fails over automatically when a provider runs out of credits; never switch models to hide a coding or test failure.\nWorkflow for every new task:\n1. Read only the files and symbols needed to judge the task, requesting them together in one turn (parallel tool calls); never paste source into handoffs. Everything you read stays in your context and is resent on every later turn: prefer narrow grep patterns and ranged reads (offset/limit) of the relevant symbols to whole files (code_outline gives a large file's declarations with line ranges without reading it, or where a symbol is used), never re-read a range already in context, and read documentation only when the task concerns it. For an audit or analysis spanning many files or large modules, do not read them yourself: call consult_readonly (purpose audit) with the paths and precise questions, then read only the ranges needed to confirm or act on its findings. To review a branch, a pull request or local work not done by delegate_implementation, call review_changes (with base and, when known, the intent in focus) instead of reading the diff yourself. Findings marked (confirmed) or (downgraded) were already checked against the code by a second model: read their code only to act on them, never just to confirm them again. Stay within the user's request: fix findings that are defects of the requested change or of its stated scope; report the others (pre-existing code, extra hardening) to the user instead of fixing them unasked, and never start a third fix-and-review round on the same change without asking the user. Between prompts, bulky tool results of accepted tasks are replaced with short notes and reads of files a later delegation changed are marked outdated: read again what you need.\n2. Classify assessment.kind, risk, uncertainty and scope using the tool schema. High risk and security/concurrency/migrations have a critical floor; architecture and high uncertainty have a large floor. Choose the profile: small = localized/mechanical; medium = normal multi-file; large = complex architecture or hard debugging; critical = security, concurrency, data migrations or truly exceptional complexity. Choose critical only when a top-tier model is clearly worth it, because it triggers the user's approval for flagship models. When torn between small/medium/large, choose the stronger one. Call plan_task first only for large or critical tasks or when the task needs several delegations; for a single small or medium delegation pass the profile directly to delegate_implementation.\n3. Decide whether to delegate at all. A delegation starts a worker with its own context, which it re-reads on every one of its turns: it costs on the order of 100k tokens before it changes a line, so it only pays for itself when it keeps bulky code out of your context. Make the change yourself with edit/write when it is small and fully determined \u2014 roughly twenty lines or fewer, or one short new file \u2014 you already know its exact content, and you have already read what it touches; then call run_verification for the project's checks and complete_task as usual. Delegate when the change needs exploration, spans several files or symbols, is long, or is risky. Never split one change between yourself and a worker, and never delegate a change you have already made.\n4. delegate_implementation with a concise task and a structured guide (FILE:, SYMBOLS:, CHANGES:, PRESERVE:, VERIFY:, every allowedPath mentioned). Use effort only when this specific change needs more or less reasoning than its profile. Otherwise use consult_readonly only for concrete uncertainty.\n5. Put the exact test/typecheck/lint commands in VERIFY (e.g. `npm test`, `npx tsc --noEmit`): the extension runs them before and after the change and lets the worker fix regressions itself. Prefer the project's whole test command over the tests of the changed file, unless the suite is slow: a change can break code elsewhere. The delegation result already contains the diff when it is small: review it there and use supervisor_git only for what it does not show; use run_verification for anything VERIFY could not cover.\n6. For corrections or follow-up steps of the same task use continuePrevious=true; do not call plan_task again for the same task.\n7. Call complete_task with accept after reviewing the final diff and checks, before your final response; use pause for unfinished work. Never accept unresolved regressions or MAJOR findings.\n8. When a failure, correction round or review finding reveals a durable repository-specific pitfall, call record_lesson with one concrete instruction; never record task-specific details.\nIf the supervisor model changes after a provider failure, re-check the task state and Git status before continuing and do not redo completed delegations. Final acceptance is your responsibility. Never commit or push unless the user explicitly asks; then use only the confirmation tools. Never merge.",
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

	pi.on("model_select", (event, ctx) => {
		if (!enabled) return;
		// Use event.model instead of ctx.model: the hook is the authoritative model-change notification and keeps the
		// bottom bar truthful even if the context snapshot is updated slightly later by Pi.
		updateStatus(ctx, event.model);
		// A model picked by the user (not by this extension) pins the supervisor until /SupervisedCoding model auto.
		if (settingModel || event.source === "restore" || supervisorMode === "manual") return;
		supervisorMode = "manual";
		persist();
		updateStatus(ctx, event.model);
	});

	pi.on("thinking_level_select", (event, ctx) => {
		if (!enabled) return;
		updateStatus(ctx, ctx.model, event.level);
	});

	pi.on("agent_before_settle", async (event, ctx) => {
		if (!enabled) return;
		if (event.outcome === "completed") {
			// Between runs, never inside one: the edits cost one prompt-cache miss for the next prompt (often cold by
			// then anyway) and make every later turn smaller.
			if (!config.contextPruning.enabled || delegationRunning) return;
			const { edits, savedBytes } = planContextEdits(event.context.contextEntries as any, { cwd: ctx.cwd, minResultBytes: config.contextPruning.minResultBytes, minTotalBytes: config.contextPruning.minTotalBytes });
			if (!edits.length) return;
			metrics.contextPrunedBytes += savedBytes;
			metrics.contextPrunedResults += edits.length;
			shownDiffs.clear();
			persist();
			return { entries: edits };
		}
		if (event.outcome !== "error" || !config.supervisorFailover || supervisorRecoveryRunning) return;
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
		shownDiffs.clear();
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
