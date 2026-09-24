/**
 * Pure routing logic for the supervisor extension: failure classification, credit/limit parsing,
 * provider health bookkeeping and candidate ranking. No Pi imports, so it can be unit-tested with plain Node.
 */

export type FailureKind = "credits" | "auth" | "unavailable" | "transient" | "context" | "task";

/** Failures that justify switching to another provider/model instead of diagnosing the task. */
export const FAILOVER_KINDS: ReadonlySet<FailureKind> = new Set(["credits", "auth", "unavailable"]);

export interface FailureSignal {
	text: string;
	httpStatus?: number;
	/** Structured error code, e.g. Claude Code assistant `error` ("billing_error", "rate_limit", "authentication_failed"). */
	errorCode?: string;
	/** A usage-limit event explicitly reported the request as rejected. */
	rateLimitRejected?: boolean;
}

const CONTEXT_PATTERN = /\b(context[ _-]?(length|window)[ _-]?(exceeded|limit)|prompt is too long|maximum context length|too many tokens in (the )?prompt)\b/i;
const CREDITS_PATTERN = new RegExp(
	[
		"quota",
		"usage[ _-]?limit",
		"(usage|weekly|daily|monthly|session|5-hour|five[ _-]hour|seven[ _-]day|opus|sonnet) limit (has been |was )?reached",
		"reached (your|the) (usage |weekly |daily |monthly |session )?limit",
		"hit (your|the) (usage |weekly |daily |monthly |session )?limit",
		"extra usage",
		"out of (extra )?usage",
		"resource[ _-]?exhausted",
		"insufficient[ _-]?(quota|credits?|funds|balance)",
		"(requires|need|needs) (usage |extra |more )?credits",
		"usage credits",
		"credit balance",
		"credit limit",
		"out of credits?",
		"no (remaining )?credits?",
		"billing",
		"payment required",
		"out of budget",
		"budget exceeded",
		"available balance",
		"spending limit",
		"upgrade (your plan|to (plus|pro|max|team))",
	].map((item) => `\\b${item}\\b`).join("|") + "|\\bcredits?\\b[^.\\n]{0,40}\\b(too low|exhausted|depleted|zero|run out)\\b",
	"i",
);
const UNAVAILABLE_PATTERN = /(\bmodel[ _-]?not[ _-]?found\b|\bnot_found_error\b|\bunknown model\b|\binvalid model\b|\bno such model\b|\bunsupported model\b|\bmodel\b[^.\n]{0,60}\b(is not available|not available|does not exist|is not supported|not supported|unavailable|deprecated|retired)\b|\bdo(es)? not have access to (the |this )?model\b|\bspawn\b[^\n]*\b(ENOENT|EINVAL|EACCES)\b|\bcommand not found\b|is not recognized as an internal or external command)/i;
const AUTH_PATTERN = /\b(unauthori[sz]ed|authentication[ _-]?(failed|error|required)?|not authenticated|forbidden|invalid[ _-]?(api[ _-]?key|x-api-key|token|credentials)|api[ _-]?key|oauth|token (has )?expired|expired token|please (log|sign) ?in|login required|not logged in|401|403)\b/i;
const TRANSIENT_PATTERN = /\b(429|rate[ _-]?limit(ed)?|too many requests|overloaded|529|capacity|temporarily unavailable|service[ _-]?unavailable|timeout|timed out|500|502|503|504|internal[ _-]?server[ _-]?error|server[ _-]?error|connection (reset|refused|error|lost)|econnreset|etimedout|socket hang up|fetch failed|network[ _-]?error|stream ended)\b/i;

export function classifyFailure(input: FailureSignal | string): FailureKind {
	const signal: FailureSignal = typeof input === "string" ? { text: input } : input;
	const text = signal.text ?? "";
	const code = (signal.errorCode ?? "").toLowerCase();
	if (signal.rateLimitRejected) return "credits";
	if (CONTEXT_PATTERN.test(text)) return "context";
	if (code === "billing_error" || signal.httpStatus === 402) return "credits";
	if (CREDITS_PATTERN.test(text)) return "credits";
	if (code === "authentication_failed" || signal.httpStatus === 401 || signal.httpStatus === 403) return "auth";
	if (code === "model_not_found") return "unavailable";
	if (signal.httpStatus === 404 || UNAVAILABLE_PATTERN.test(text)) return "unavailable";
	if (AUTH_PATTERN.test(text)) return "auth";
	if (code === "rate_limit" || code === "server_error" || code === "overloaded_error") return "transient";
	if (signal.httpStatus !== undefined && (signal.httpStatus === 429 || signal.httpStatus >= 500)) return "transient";
	if (TRANSIENT_PATTERN.test(text)) return "transient";
	return "task";
}

const UNIT_MS: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 };

function durationMs(fragment: string): number | undefined {
	let total = 0;
	let matched = false;
	for (const match of fragment.matchAll(/([\d.]+)\s*(d(?:ays?)?|h(?:ours?|rs?)?|m(?:in(?:ute)?s?)?|s(?:ec(?:ond)?s?)?)\b/gi)) {
		const value = Number(match[1]);
		if (!Number.isFinite(value)) continue;
		total += value * UNIT_MS[match[2][0].toLowerCase()];
		matched = true;
	}
	return matched ? total : undefined;
}

function epochToMs(value: number): number {
	return value < 1e12 ? value * 1000 : value;
}

/** Best-effort extraction of "when does this limit reset" from a provider error message. */
export function parseResetHint(text: string, now = Date.now()): number | undefined {
	if (!text) return undefined;
	const pipeEpoch = /\|(\d{10,13})\b/.exec(text);
	if (pipeEpoch) return epochToMs(Number(pipeEpoch[1]));
	const iso = /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)\b/.exec(text);
	if (iso && /reset|retry|try again|available|until/i.test(text)) {
		const parsed = Date.parse(iso[1]);
		if (Number.isFinite(parsed) && parsed > now) return parsed;
	}
	const relative = /\b(?:try again|retry|resets?|reset|available again)\s*(?:in|after)\s*((?:[\d.]+\s*(?:d(?:ays?)?|h(?:ours?|rs?)?|m(?:in(?:ute)?s?)?|s(?:ec(?:ond)?s?)?)\s*,?\s*(?:and\s*)?)+)/i.exec(text);
	if (relative) {
		const ms = durationMs(relative[1]);
		if (ms !== undefined) return now + ms;
	}
	const clock = /\bresets?\s*(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(text) ?? /\bresets?\s*(?:at\s*)?(\d{1,2}):(\d{2})\b()/i.exec(text);
	if (clock) {
		let hours = Number(clock[1]);
		const minutes = clock[2] ? Number(clock[2]) : 0;
		const meridiem = clock[3]?.toLowerCase();
		if (meridiem === "pm" && hours < 12) hours += 12;
		if (meridiem === "am" && hours === 12) hours = 0;
		if (hours > 23 || minutes > 59) return undefined;
		const date = new Date(now);
		date.setHours(hours, minutes, 0, 0);
		if (date.getTime() <= now) date.setDate(date.getDate() + 1);
		return date.getTime();
	}
	return undefined;
}

export type HealthStatus = "ok" | "warning" | "exhausted" | "unknown";

export interface UsageWindow {
	utilization?: number;
	resetsAt?: number;
}

export interface ProviderHealth {
	status: HealthStatus;
	/** Highest known utilization across windows, 0..1. */
	utilization?: number;
	windows?: Record<string, UsageWindow>;
	/** When a known limit resets (ms epoch). */
	resetsAt?: number;
	/** While exhausted: do not route here before this time (ms epoch). */
	blockedUntil?: number;
	reason?: string;
	source: string;
	updatedAt: number;
}

export type HealthMap = Record<string, ProviderHealth>;

export interface LimitReading {
	status: HealthStatus;
	utilization?: number;
	windows: Record<string, UsageWindow>;
	resetsAt?: number;
	/** Only the headers relevant to limits/usage, for diagnostics. */
	raw: Record<string, string>;
}

const LIMIT_HEADER = /ratelimit|rate-limit|x-codex|quota|usage|credit|balance/i;

function numeric(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number(value.trim());
	return Number.isFinite(parsed) ? parsed : undefined;
}

function resetValueMs(value: string, now: number, afterSeconds: boolean): number | undefined {
	const number = numeric(value);
	if (number !== undefined) return afterSeconds ? now + number * 1000 : number > 1e9 ? epochToMs(number) : now + number * 1000;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Read subscription/credit limits from provider response headers. Handles OpenAI Codex
 * (`x-codex-*-used-percent`, `*-reset-after-seconds`) and Anthropic unified limits
 * (`anthropic-ratelimit-unified-*`). Per-minute request/token throttles are kept only as raw diagnostics.
 */
export function readLimitHeaders(headers: Record<string, string | undefined>, now = Date.now()): LimitReading | undefined {
	const raw: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		if (value !== undefined && LIMIT_HEADER.test(key)) raw[key.toLowerCase()] = String(value);
	}
	if (!Object.keys(raw).length) return undefined;
	const windows: Record<string, UsageWindow> = {};
	let explicitStatus: HealthStatus | undefined;
	for (const [key, value] of Object.entries(raw)) {
		let match: RegExpExecArray | null;
		if ((match = /^(.*?)[-_]?used[-_]percent$/.exec(key))) {
			const percent = numeric(value);
			if (percent !== undefined) (windows[match[1]] ??= {}).utilization = percent / 100;
		} else if ((match = /^(.*?)[-_]?utilization$/.exec(key))) {
			const utilization = numeric(value);
			if (utilization !== undefined) (windows[match[1]] ??= {}).utilization = utilization > 1.5 ? utilization / 100 : utilization;
		} else if ((match = /^(.*?)[-_]?reset[-_]after[-_]seconds$/.exec(key))) {
			const reset = resetValueMs(value, now, true);
			if (reset !== undefined) (windows[match[1]] ??= {}).resetsAt = reset;
		} else if ((match = /^(anthropic-ratelimit-unified.*?|x-codex.*?)[-_]?reset(?:[-_]at)?$/.exec(key))) {
			const reset = resetValueMs(value, now, false);
			if (reset !== undefined) (windows[match[1]] ??= {}).resetsAt = reset;
		} else if (/^anthropic-ratelimit-unified(-[a-z0-9]+)?-status$/.test(key)) {
			const status = value.toLowerCase();
			if (status === "rejected") explicitStatus = "exhausted";
			else if (status.includes("warning") && explicitStatus !== "exhausted") explicitStatus = "warning";
			else if (status === "allowed" && !explicitStatus) explicitStatus = "ok";
		}
	}
	const utilizations = Object.values(windows).map((item) => item.utilization).filter((item): item is number => item !== undefined);
	const utilization = utilizations.length ? Math.max(...utilizations) : undefined;
	const status: HealthStatus = explicitStatus ?? (utilization === undefined ? "unknown" : utilization >= 0.999 ? "exhausted" : "ok");
	return { status, utilization, windows, resetsAt: pickReset(windows, status), raw };
}

/** For an exhausted account use the latest reset among saturated windows; otherwise the earliest known reset. */
function pickReset(windows: Record<string, UsageWindow>, status: HealthStatus): number | undefined {
	const entries = Object.values(windows).filter((item) => item.resetsAt !== undefined);
	if (!entries.length) return undefined;
	if (status === "exhausted") {
		const saturated = entries.filter((item) => (item.utilization ?? 0) >= 0.999);
		const pool = saturated.length ? saturated : entries;
		return Math.max(...pool.map((item) => item.resetsAt as number));
	}
	return Math.min(...entries.map((item) => item.resetsAt as number));
}

/** Claude Code `rate_limit_event.rate_limit_info` → reading. */
export function readClaudeRateLimit(info: Record<string, any> | undefined): LimitReading | undefined {
	if (!info || typeof info !== "object") return undefined;
	const windows: Record<string, UsageWindow> = {};
	const unified = info.unifiedWindows && typeof info.unifiedWindows === "object" ? info.unifiedWindows : {};
	for (const [name, data] of Object.entries(unified as Record<string, any>)) {
		windows[name] = {
			utilization: typeof data?.utilization === "number" ? data.utilization : undefined,
			resetsAt: typeof data?.resetsAt === "number" ? epochToMs(data.resetsAt) : undefined,
		};
	}
	const utilizations = Object.values(windows).map((item) => item.utilization).filter((item): item is number => item !== undefined);
	const utilization = utilizations.length ? Math.max(...utilizations) : undefined;
	const rawStatus = String(info.status ?? "").toLowerCase();
	const status: HealthStatus = rawStatus === "rejected" ? "exhausted" : rawStatus.includes("warning") ? "warning" : rawStatus === "allowed" ? "ok" : "unknown";
	const resetsAt = typeof info.resetsAt === "number" ? epochToMs(info.resetsAt) : pickReset(windows, status);
	return { status, utilization, windows, resetsAt, raw: { rateLimitType: String(info.rateLimitType ?? ""), status: rawStatus } };
}

export function applyReading(health: HealthMap, key: string, reading: LimitReading, source: string, cooldownMs: number, now = Date.now()): void {
	const previous = health[key];
	health[key] = {
		status: reading.status === "unknown" ? previous?.status ?? "unknown" : reading.status,
		utilization: reading.utilization ?? previous?.utilization,
		windows: Object.keys(reading.windows).length ? reading.windows : previous?.windows,
		resetsAt: reading.resetsAt ?? previous?.resetsAt,
		blockedUntil: reading.status === "exhausted" ? reading.resetsAt ?? now + cooldownMs : reading.status === "unknown" ? previous?.blockedUntil : undefined,
		reason: reading.status === "exhausted" ? `limit reached (${source})` : previous?.reason,
		source,
		updatedAt: now,
	};
}

export function markExhausted(health: HealthMap, key: string, reason: string, until: number, source: string, now = Date.now()): void {
	const previous = health[key];
	health[key] = { ...previous, status: "exhausted", blockedUntil: until, resetsAt: until, reason: reason.slice(0, 300), source, updatedAt: now };
}

export function markHealthy(health: HealthMap, key: string, source: string, now = Date.now()): void {
	const previous = health[key];
	if (previous?.status === "exhausted" || !previous) {
		health[key] = { ...previous, status: "ok", blockedUntil: undefined, reason: undefined, source, updatedAt: now };
	} else {
		health[key] = { ...previous, source, updatedAt: now };
	}
}

export type Availability = "ok" | "degraded" | "blocked";

export function availability(health: HealthMap, keys: string[], headroom: number, now = Date.now()): { state: Availability; until?: number; reason?: string } {
	let degraded = false;
	for (const key of keys) {
		const item = health[key];
		if (!item) continue;
		if (item.status === "exhausted" && (item.blockedUntil ?? 0) > now) return { state: "blocked", until: item.blockedUntil, reason: item.reason };
		// Readings taken before a limit reset (or an expired block) no longer describe the account.
		if (item.status === "exhausted" || (item.resetsAt !== undefined && item.resetsAt <= now)) continue;
		if (item.status === "warning" || (item.utilization !== undefined && item.utilization >= headroom)) degraded = true;
	}
	return { state: degraded ? "degraded" : "ok" };
}

export interface RankedCandidate<T> {
	candidate: T;
	index: number;
	state: Availability;
	until?: number;
	reason?: string;
}

/**
 * Keep the configured quality order, but move candidates near their limit behind healthy ones and
 * drop candidates whose provider is known to be exhausted. Blocked candidates are returned separately.
 */
export function rankCandidates<T>(candidates: T[], keysOf: (candidate: T) => string[], health: HealthMap, headroom: number, now = Date.now()): { usable: RankedCandidate<T>[]; blocked: RankedCandidate<T>[] } {
	const ranked = candidates.map((candidate, index) => ({ candidate, index, ...availability(health, keysOf(candidate), headroom, now) }));
	const usable = ranked.filter((item) => item.state !== "blocked").sort((a, b) => (a.state === b.state ? a.index - b.index : a.state === "ok" ? -1 : 1));
	return { usable, blocked: ranked.filter((item) => item.state === "blocked") };
}

/** Claude model id → family used for family-specific limits ("claude-opus-5-5" → "opus"). */
export function claudeFamily(model: string): string {
	const match = /(opus|sonnet|haiku|fable)/i.exec(model);
	return match ? match[1].toLowerCase() : model.toLowerCase();
}

/**
 * Which health key a Claude Code limit applies to. `credits_required` means this model is not included in the plan
 * (e.g. "Fable 5.1 requires usage credits") while other models keep working; a family window such as
 * "seven_day_opus" blocks only that family; anything else is the whole account.
 */
export function claudeLimitKey(info: { rateLimitType?: unknown; errorCode?: unknown } | undefined, model: string): string {
	if (info?.errorCode === "credits_required") return `claude-cli:model:${model}`;
	const family = /(opus|sonnet|haiku|fable)/i.exec(typeof info?.rateLimitType === "string" ? info.rateLimitType : "");
	return family ? `claude-cli:${family[1].toLowerCase()}` : "claude-cli";
}

export function formatUntil(until: number | undefined, now = Date.now()): string {
	if (!until) return "unknown";
	const minutes = Math.max(0, Math.round((until - now) / 60_000));
	const clock = new Date(until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	return minutes >= 120 ? `${clock} (~${Math.round(minutes / 60)}h)` : `${clock} (~${minutes}m)`;
}
