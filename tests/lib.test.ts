// Run with: node --test tests/lib.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	applyReading,
	availability,
	classifyFailure,
	claudeLimitKey,
	markExhausted,
	parseResetHint,
	rankCandidates,
	readClaudeRateLimit,
	readLimitHeaders,
	type HealthMap,
} from "../lib.ts";

const NOW = Date.UTC(2026, 8, 24, 10, 0, 0);

test("real provider messages from Pi sessions are classified as credit exhaustion", () => {
	assert.equal(classifyFailure("Codex error: The usage limit has been reached"), "credits");
	assert.equal(
		classifyFailure('400 {"type":"error","error":{"type":"invalid_request_error","message":"Third-party apps now draw from your extra usage, not your plan limits. Add more at claude.ai/settings/usage and keep going."}}'),
		"credits",
	);
});

test("common credit/limit wordings", () => {
	for (const text of [
		"Your credit balance is too low to access the Anthropic API.",
		"Claude AI usage limit reached|1790253000",
		"You've hit your limit · resets 3pm (Europe/Rome)",
		"5-hour limit reached ∙ resets 1pm",
		"Weekly limit reached",
		"429 RESOURCE_EXHAUSTED: Quota exceeded for metric generate_content_free_tier_requests",
		"You exceeded your current quota, please check your plan and billing details.",
		"insufficient_quota",
		"402 Payment Required",
		"You're out of extra usage",
	]) {
		assert.equal(classifyFailure(text), "credits", text);
	}
});

test("structured signals win over text", () => {
	assert.equal(classifyFailure({ text: "", rateLimitRejected: true }), "credits");
	assert.equal(classifyFailure({ text: "request failed", errorCode: "billing_error" }), "credits");
	assert.equal(classifyFailure({ text: "request failed", errorCode: "authentication_failed" }), "auth");
	assert.equal(classifyFailure({ text: "slow down", errorCode: "rate_limit" }), "transient");
	assert.equal(classifyFailure({ text: "", httpStatus: 402 }), "credits");
	assert.equal(classifyFailure({ text: "", httpStatus: 503 }), "transient");
});

test("other failure kinds", () => {
	assert.equal(classifyFailure("model_not_found: The model `claude-fable-9` does not exist"), "unavailable");
	assert.equal(classifyFailure("spawn claude.cmd EINVAL"), "unavailable");
	assert.equal(classifyFailure("401 Unauthorized: invalid x-api-key"), "auth");
	assert.equal(classifyFailure("Please log in again: OAuth token has expired"), "auth");
	assert.equal(classifyFailure("529 Overloaded"), "transient");
	assert.equal(classifyFailure("429 Too Many Requests"), "transient");
	assert.equal(classifyFailure("prompt is too long: 1200000 tokens > 1000000 maximum"), "context");
	assert.equal(classifyFailure("3 tests failed in src/parser.test.ts"), "task");
});

test("reset hints", () => {
	assert.equal(parseResetHint("Claude AI usage limit reached|1790253000", NOW), 1790253000 * 1000);
	assert.equal(parseResetHint("Please retry in 23.5s.", NOW), NOW + 23_500);
	assert.equal(parseResetHint("Try again in 2h 30m", NOW), NOW + 9_000_000);
	const clock = parseResetHint("You've hit your limit · resets 3pm", NOW);
	assert.ok(clock && clock > NOW && clock - NOW <= 86_400_000);
	assert.equal(new Date(clock as number).getHours(), 15);
	assert.equal(parseResetHint("no hint here", NOW), undefined);
});

test("Codex headers", () => {
	const reading = readLimitHeaders({
		"x-codex-primary-used-percent": "100",
		"x-codex-primary-reset-after-seconds": "600",
		"x-codex-secondary-used-percent": "42",
		"x-codex-secondary-reset-after-seconds": "86400",
		"content-type": "text/event-stream",
	}, NOW);
	assert.ok(reading);
	assert.equal(reading.status, "exhausted");
	assert.equal(reading.utilization, 1);
	assert.equal(reading.resetsAt, NOW + 600_000);
	assert.equal(reading.raw["content-type"], undefined);
});

test("Anthropic unified headers", () => {
	const reading = readLimitHeaders({
		"anthropic-ratelimit-unified-status": "allowed_warning",
		"anthropic-ratelimit-unified-5h-utilization": "0.93",
		"anthropic-ratelimit-unified-5h-reset": "1790253000",
		"anthropic-ratelimit-unified-7d-utilization": "0.4",
	}, NOW);
	assert.ok(reading);
	assert.equal(reading.status, "warning");
	assert.equal(reading.utilization, 0.93);
	assert.equal(reading.resetsAt, 1790253000 * 1000);
});

test("per-minute throttles alone do not mark exhaustion", () => {
	const reading = readLimitHeaders({ "x-ratelimit-remaining-requests": "0", "x-ratelimit-reset-requests": "1s" }, NOW);
	assert.equal(reading?.status, "unknown");
});

test("Claude Code rate_limit_event (captured from CLI 2.1.281)", () => {
	const info = { status: "allowed", resetsAt: 1790253000, rateLimitType: "five_hour", overageStatus: "rejected", isUsingOverage: false, unifiedWindows: { five_hour: { utilization: 0.28, resetsAt: 1790253000 }, seven_day: { utilization: 0.4, resetsAt: 1790384400 } } };
	const reading = readClaudeRateLimit(info);
	assert.ok(reading);
	assert.equal(reading.status, "ok");
	assert.equal(reading.utilization, 0.4);
	const rejected = readClaudeRateLimit({ ...info, status: "rejected", rateLimitType: "seven_day_opus" });
	assert.equal(rejected?.status, "exhausted");
	assert.equal(claudeLimitKey({ rateLimitType: "seven_day_opus" }, "claude-opus-5-5"), "claude-cli:opus");
	assert.equal(claudeLimitKey({ rateLimitType: "five_hour" }, "claude-sonnet-5"), "claude-cli");
});

test("model outside the plan blocks only that model (captured: claude-fable-5-1, CLI 2.1.281)", () => {
	const info = { status: "rejected", resetsAt: 1790812800, overageDisabledReason: "org_level_disabled", isUsingOverage: false, errorCode: "credits_required", canUserPurchaseCredits: true };
	assert.equal(readClaudeRateLimit(info)?.status, "exhausted");
	assert.equal(claudeLimitKey(info, "claude-fable-5-1"), "claude-cli:model:claude-fable-5-1");
	const text = "Fable 5.1 requires usage credits. Switch to another model, or manage usage credits at claude.ai/settings/usage?from=cc_cli_limit_message, to continue.";
	assert.equal(classifyFailure({ text, errorCode: "rate_limit", httpStatus: 429, rateLimitRejected: true }), "credits");
	assert.equal(classifyFailure(text), "credits");
});

test("nonexistent model (captured from CLI 2.1.281)", () => {
	const text = "There's an issue with the selected model (claude-bogus-9). It may not exist or you may not have access to it.";
	assert.equal(classifyFailure({ text, errorCode: "model_not_found", httpStatus: 404 }), "unavailable");
	assert.equal(classifyFailure({ text, httpStatus: 404 }), "unavailable");
});

test("a provider warning below the headroom does not demote a strong worker (seen live: Claude allowed_warning at 92%)", () => {
	const health: HealthMap = {};
	applyReading(health, "claude-cli", { status: "warning", utilization: 0.92, windows: {}, raw: {} }, "test", 60_000, NOW);
	assert.equal(availability(health, ["claude-cli"], 0.97, NOW).state, "ok");
	assert.equal(availability(health, ["claude-cli"], 0.9, NOW).state, "degraded");
	applyReading(health, "pi:openai-codex", { status: "warning", windows: {}, raw: {} }, "test", 60_000, NOW);
	assert.equal(availability(health, ["pi:openai-codex"], 0.97, NOW).state, "degraded", "without a utilization figure the warning still counts");
});

test("ranking keeps quality order, skips exhausted providers, demotes near-limit ones", () => {
	const health: HealthMap = {};
	const candidates = [
		{ name: "opus", keys: ["claude-cli", "claude-cli:opus"] },
		{ name: "sonnet", keys: ["claude-cli", "claude-cli:sonnet"] },
		{ name: "gpt", keys: ["pi:openai-codex"] },
	];
	const keys = (item: { keys: string[] }) => item.keys;
	assert.deepEqual(rankCandidates(candidates, keys, health, 0.9, NOW).usable.map((item) => item.candidate.name), ["opus", "sonnet", "gpt"]);

	markExhausted(health, "claude-cli:opus", "weekly opus limit", NOW + 3_600_000, "test", NOW);
	assert.deepEqual(rankCandidates(candidates, keys, health, 0.9, NOW).usable.map((item) => item.candidate.name), ["sonnet", "gpt"]);

	applyReading(health, "claude-cli", { status: "warning", utilization: 0.95, windows: {}, raw: {} }, "test", 60_000, NOW);
	assert.deepEqual(rankCandidates(candidates, keys, health, 0.9, NOW).usable.map((item) => item.candidate.name), ["gpt", "sonnet"]);

	markExhausted(health, "claude-cli", "usage limit", NOW + 60_000, "test", NOW);
	const ranked = rankCandidates(candidates, keys, health, 0.9, NOW);
	assert.deepEqual(ranked.usable.map((item) => item.candidate.name), ["gpt"]);
	assert.equal(ranked.blocked.length, 2);

	// After the reset time the provider becomes usable again.
	assert.equal(availability(health, ["claude-cli"], 0.9, NOW + 120_000).state, "ok");
});
