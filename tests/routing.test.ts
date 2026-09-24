// Unit tests of routing.ts: task assessment floors, cold-start effort, evidence-based ordering.
// Run: node --test tests/routing.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { OutcomeRecord } from "../learning.ts";
import { assessTask, routeWithEvidence, taskEffort } from "../routing.ts";

test("assessment raises the requested profile, never lowers it", () => {
	assert.equal(assessTask("small", { kind: "security" }).profile, "critical");
	assert.equal(assessTask("small", { risk: "high" }).profile, "critical");
	assert.equal(assessTask("small", { kind: "architecture" }).profile, "large");
	assert.equal(assessTask("medium", { uncertainty: "high" }).profile, "large");
	assert.equal(assessTask("small", { scope: "multi-file" }).profile, "medium");
	assert.equal(assessTask("large", { kind: "docs", risk: "low", scope: "local" }).profile, "large");
	assert.deepEqual(assessTask("medium", {}).reasons, [], "no reasons when the profile stands");
});

test("only small, local, low-risk mechanical or docs work starts at low effort", () => {
	const easy = { kind: "docs" as const, risk: "low" as const, uncertainty: "low" as const, scope: "local" as const };
	assert.equal(taskEffort("small", easy, "medium"), "low");
	assert.equal(taskEffort("medium", easy, "high"), "high");
	assert.equal(taskEffort("small", { ...easy, kind: "feature" }, "medium"), "medium");
	assert.equal(taskEffort("small", { ...easy, risk: "medium" }, "medium"), "medium");
});

const candidates = [
	{ worker: "claude", model: "sonnet", effort: "high" },
	{ worker: "pi", provider: "openai-codex", model: "gpt", effort: "high" },
];
const accepted = (model: string, worker: string, i: number, costUsd: number): OutcomeRecord => ({
	evidenceVersion: 2, taskKind: "feature", accepted: true, at: Date.now(), repo: "r", taskId: `${model}-${i}`, profile: "medium",
	worker, model, effort: "high", verification: "passed", correctionRounds: 0, review: "none", failed: false, tokens: 0, costUsd,
});

test("a cheaper model moves ahead only with enough accepted evidence for both candidates", () => {
	const sonnet = Array.from({ length: 20 }, (_, i) => accepted("sonnet", "claude", i, 1));
	const gpt = Array.from({ length: 20 }, (_, i) => accepted("gpt", "pi", i, 0.5));
	assert.equal(routeWithEvidence(candidates, sonnet, "r", "medium", "feature").candidates[0].model, "sonnet", "no evidence for the cheaper one");
	assert.equal(routeWithEvidence(candidates, [...sonnet, ...gpt.slice(0, 19)], "r", "medium", "feature").candidates[0].model, "sonnet", "19 tasks are not enough");
	const routed = routeWithEvidence(candidates, [...sonnet, ...gpt], "r", "medium", "feature");
	assert.equal(routed.candidates[0].model, "gpt");
	assert.match(routed.reason, /20% below/);
	assert.equal(routeWithEvidence(candidates, [...sonnet, ...gpt], "r", "large", "feature").candidates[0].model, "sonnet", "no savings reordering in large/critical");
	assert.equal(routeWithEvidence(candidates, [...sonnet, ...gpt], "other-repo", "medium", "feature").candidates[0].model, "sonnet", "evidence is per repository");
});

test("a single failed task disqualifies a cheaper model from moving ahead", () => {
	const sonnet = Array.from({ length: 20 }, (_, i) => accepted("sonnet", "claude", i, 1));
	const gpt = Array.from({ length: 20 }, (_, i) => accepted("gpt", "pi", i, 0.5));
	gpt[5] = { ...gpt[5], verification: "fixed" };
	assert.equal(routeWithEvidence(candidates, [...sonnet, ...gpt], "r", "medium", "feature").candidates[0].model, "sonnet");
});
