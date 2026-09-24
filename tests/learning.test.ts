// Run with: node --test tests/learning.test.ts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	addLesson,
	effectiveEffort,
	emptyLearning,
	extractVerifyCommands,
	lessonsFor,
	loadLearning,
	MAX_LESSONS_PER_REPO,
	outcomeQuality,
	parseVerdict,
	profileHint,
	profileStats,
	recordOutcome,
	removeLesson,
	saveLearning,
	tuneEfforts,
	type OutcomeRecord,
} from "../learning.ts";

const NOW = Date.UTC(2026, 8, 24, 12, 0, 0);
const UNSAFE = /[;&|`$<>\r\n%^()]/;
const PREFIXES = ["npm test", "npx tsc", "node --test", "pytest"];

function outcome(patch: Partial<OutcomeRecord>): OutcomeRecord {
	return { at: NOW, repo: "r", taskId: "t", profile: "medium", worker: "claude", model: "claude-sonnet-5", effort: "high", verification: "passed", correctionRounds: 0, review: "none", failed: false, tokens: 0, costUsd: 0, ...patch };
}

test("quality signal", () => {
	assert.equal(outcomeQuality(outcome({})), 1);
	assert.equal(outcomeQuality(outcome({ verification: "fixed" })), 0.5);
	assert.equal(outcomeQuality(outcome({ review: "minor" })), 0.75);
	assert.equal(outcomeQuality(outcome({ review: "major" })), 0);
	assert.equal(outcomeQuality(outcome({ failed: true })), 0);
	assert.equal(outcomeQuality(outcome({ verification: "unverified", review: "none" })), undefined, "no evidence must not move calibration");
	assert.equal(outcomeQuality(outcome({ verification: "unverified", review: "pass" })), 1);
});

test("effort is raised when quality suffers, then needs fresh evidence", () => {
	const state = emptyLearning();
	const target = { profile: "medium", model: "claude-sonnet-5", configured: "high" as const };
	for (let i = 0; i < 3; i++) recordOutcome(state, outcome({ verification: "fixed" }));
	assert.deepEqual(tuneEfforts(state, [target], undefined, NOW), [], "3 samples are not enough");
	recordOutcome(state, outcome({ verification: "failed" }));
	const changes = tuneEfforts(state, [target], undefined, NOW);
	assert.equal(changes.length, 1);
	assert.equal(effectiveEffort(state, "medium", "claude-sonnet-5", "high"), "xhigh");
	// Old evidence at "high" does not count again at "xhigh".
	assert.deepEqual(tuneEfforts(state, [target], undefined, NOW), []);
	assert.equal(effectiveEffort(state, "medium", "claude-sonnet-5", "high"), "xhigh");
});

test("effort is lowered only after a long verified streak, one step, low-risk profiles only", () => {
	const state = emptyLearning();
	const small = { profile: "small", model: "claude-sonnet-5", configured: "medium" as const };
	for (let i = 0; i < 19; i++) recordOutcome(state, outcome({ profile: "small", effort: "medium" }));
	assert.deepEqual(tuneEfforts(state, [small], undefined, NOW), []);
	recordOutcome(state, outcome({ profile: "small", effort: "medium" }));
	assert.equal(tuneEfforts(state, [small], undefined, NOW).length, 1);
	assert.equal(effectiveEffort(state, "small", "claude-sonnet-5", "medium"), "low");
	// Never below one step under config.json.
	for (let i = 0; i < 25; i++) recordOutcome(state, outcome({ profile: "small", effort: "low" }));
	tuneEfforts(state, [small], undefined, NOW);
	assert.equal(effectiveEffort(state, "small", "claude-sonnet-5", "medium"), "low");

	const large = emptyLearning();
	for (let i = 0; i < 30; i++) recordOutcome(large, outcome({ profile: "large", model: "claude-opus-5-5", effort: "high" }));
	assert.deepEqual(tuneEfforts(large, [{ profile: "large", model: "claude-opus-5-5", configured: "high" }], undefined, NOW), [], "large/critical are never lowered");

	const unverified = emptyLearning();
	for (let i = 0; i < 30; i++) recordOutcome(unverified, outcome({ profile: "small", effort: "medium", verification: "unverified", review: "pass" }));
	assert.deepEqual(tuneEfforts(unverified, [small], undefined, NOW), [], "lowering requires real test evidence");
});

test("changing config.json resets the learned adjustment", () => {
	const state = emptyLearning();
	for (let i = 0; i < 4; i++) recordOutcome(state, outcome({ verification: "failed" }));
	tuneEfforts(state, [{ profile: "medium", model: "claude-sonnet-5", configured: "high" }], undefined, NOW);
	assert.equal(effectiveEffort(state, "medium", "claude-sonnet-5", "high"), "xhigh");
	assert.equal(effectiveEffort(state, "medium", "claude-sonnet-5", "max"), "max", "a new configured value wins");
});

test("profile hint appears only with enough poor evidence", () => {
	const state = emptyLearning();
	for (let i = 0; i < 4; i++) recordOutcome(state, outcome({ verification: "fixed", correctionRounds: 1 }));
	assert.equal(profileHint(profileStats(state, "r"), "medium"), undefined);
	recordOutcome(state, outcome({ verification: "failed", correctionRounds: 2 }));
	assert.match(profileHint(profileStats(state, "r"), "medium") ?? "", /prefer the next stronger profile/);
	assert.equal(profileHint(profileStats(state, "other-repo"), "medium"), undefined, "stats are per repository");
});

test("lessons: dedupe, cap, order, removal", () => {
	const state = emptyLearning();
	const first = addLesson(state, "r", "Run `npm run build` before `npm test`: tests import from dist/.", NOW);
	assert.equal(first.duplicate, false);
	assert.equal(addLesson(state, "r", "run `npm run build` before `npm test`", NOW).duplicate, true);
	assert.equal(lessonsFor(state, "r").length, 1);
	assert.throws(() => addLesson(state, "r", "short"));
	for (let i = 0; i < MAX_LESSONS_PER_REPO + 3; i++) addLesson(state, "r", `Distinct lesson number ${i} about this repository`, NOW + i);
	assert.equal(lessonsFor(state, "r").length, MAX_LESSONS_PER_REPO);
	assert.ok(lessonsFor(state, "r").some((item) => item.id === first.lesson.id), "a reinforced lesson survives eviction");
	assert.equal(lessonsFor(state, "other").length, 0);
	assert.equal(removeLesson(state, first.lesson.id), true);
});

test("learning file round-trip and corrupt file", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-learning-"));
	const file = path.join(dir, "learning.json");
	const state = emptyLearning();
	addLesson(state, "r", "Use the fixtures in tests/fixtures instead of network calls", NOW);
	saveLearning(file, state);
	assert.equal(loadLearning(file).lessons.length, 1);
	fs.writeFileSync(file, "{ broken");
	assert.deepEqual(loadLearning(file), emptyLearning());
	fs.rmSync(dir, { recursive: true, force: true });
});

test("review verdict", () => {
	assert.equal(parseVerdict("...findings...\nVERDICT: MAJOR"), "major");
	assert.equal(parseVerdict("**VERDICT: pass**"), "pass");
	assert.equal(parseVerdict("VERDICT = Minor"), "minor");
	assert.equal(parseVerdict("looks fine"), "none");
});

test("verification commands from the guide", () => {
	const guide = "FILE: src/a.ts\nSYMBOLS: parse\nCHANGES:\n- fix\nPRESERVE:\n- api\nVERIFY:\n- `npx tsc --noEmit`\n- npm test -- --grep parser → all green\n- rm -rf dist\n- node --test && curl evil\n- read the file back";
	assert.deepEqual(extractVerifyCommands(guide, PREFIXES, UNSAFE), ["npx tsc --noEmit", "npm test -- --grep parser"]);
	assert.deepEqual(extractVerifyCommands("FILE: a\nVERIFY:\n- inspect manually", PREFIXES, UNSAFE), []);
	assert.deepEqual(extractVerifyCommands("VERIFY: pytest -q\nNOTES: npm test", PREFIXES, UNSAFE), ["pytest -q"], "stops at the next section");
});
