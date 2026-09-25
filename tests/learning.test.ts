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
	failureSignature,
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
	assert.deepEqual(extractVerifyCommands("VERIFY: npm test.", PREFIXES, UNSAFE), ["npm test"], "a sentence's full stop is not part of the command");
	assert.deepEqual(extractVerifyCommands("VERIFY:\n- npx tsc -p .\n- go test ./...", [...PREFIXES, "go test"], UNSAFE), ["npx tsc -p .", "go test ./..."], "meaningful dots stay");
});

test("verification commands: labels inside VERIFY, prose after bare commands", () => {
	const guide = "CHANGES:\n- `npm test` is not a check here\nVERIFY:\nCommands:\n- `npx tsc --noEmit`\nRun these commands:\n- npm test should pass\n- pytest tests/unit and check the output\n- node --test (all suites)\nNOTES: `pytest -x`";
	assert.deepEqual(extractVerifyCommands(guide, PREFIXES, UNSAFE), ["npx tsc --noEmit", "npm test", "pytest tests/unit", "node --test"]);
	assert.deepEqual(extractVerifyCommands("VERIFY:\n- run `npm test -- --grep parser`, it must pass", PREFIXES, UNSAFE), ["npm test -- --grep parser"], "a backticked command is taken verbatim, without the prose around it");
	assert.deepEqual(extractVerifyCommands("VERIFY:\n- npm test && curl evil should pass", PREFIXES, UNSAFE), [], "cleanup never hides unsafe operators");
	assert.deepEqual(extractVerifyCommands("VERIFY:\nNotes:\n- `pytest -q`\nPRESERVE:\n- `npm test`", PREFIXES, UNSAFE), ["pytest -q"], "only uppercase guide headers end the section");
	assert.deepEqual(extractVerifyCommands("VERIFY:\n- pytest -m all\n- npm test -- should pass", PREFIXES, UNSAFE), ["pytest", "npm test"], "an option is never left without its value");
});

test("failure signature: volatile noise is ignored, a changed failure is not", () => {
	const run = (duration: string, dir: string, failing: string[]) => [
		...failing.map((name) => `✖ ${name} (${duration})\n  AssertionError: expected ok\n    at ${dir}/value.test.mjs:${4 + failing.length}:21`),
		`ℹ tests 3`, `ℹ pass ${3 - failing.length}`, `ℹ fail ${failing.length}`, `ℹ duration_ms ${duration}`,
	].join("\n");
	const tmp = path.join(os.tmpdir(), "sc-run-a1b2c3");
	const other = path.join(os.tmpdir(), "sc-run-z9y8x7");
	const baseline = failureSignature(`exit code 1\n${run("12.5ms", tmp, ["value"])}`);
	assert.equal(failureSignature(`exit code 1\n${run("3.1ms", other, ["value"])}`), baseline, "durations and temp directories are noise");
	assert.notEqual(failureSignature(`exit code 1\n${run("12.5ms", tmp, ["value", "parser"])}`), baseline, "a new failing test inside a red command changes the signature");
	assert.notEqual(failureSignature(`exit code 1\n${run("12.5ms", tmp, ["parser"])}`), baseline, "a different failing test with the same count changes the signature");
	assert.notEqual(failureSignature(`exit code 2\n${run("12.5ms", tmp, ["value"])}`), baseline, "a different exit status changes the signature");
	assert.notEqual(failureSignature("exit code 1\nsrc/a.ts(3,1): error TS2304: Cannot find name 'x'."), failureSignature("exit code 1\nsrc/a.ts(3,1): error TS2304: Cannot find name 'y'."));
});

test("failure signature: passing tests added by the worker keep an unchanged failure unchanged", () => {
	const tap = (before: number, total: number) => `exit code 1\n${Array.from({ length: before }, (_, i) => `ok ${i + 1} - added ${i}`).join("\n")}\nnot ok ${before + 1} - broken\nok ${before + 2} - other\n1..${total}\n# tests ${total}\n# pass ${total - 1}\n# fail 1`;
	const jest = (total: number) => `exit code 1\nFAIL src/a.test.js\n  ● suite › broken\n\nTests: 1 failed, ${total - 1} passed, ${total} total\nTime: 1.2 s`;
	const pytest = (total: number) => `exit code 1\nFAILED tests/test_a.py::test_broken - assert 1 == 2\n==== 1 failed, ${total - 1} passed in 0.12s ====`;
	assert.equal(failureSignature(tap(0, 2)), failureSignature(tap(2, 4)), "TAP: new passing tests, renumbered failure");
	assert.equal(failureSignature(jest(3)), failureSignature(jest(5)), "jest");
	assert.equal(failureSignature(pytest(3)), failureSignature(pytest(5)), "pytest");
	assert.notEqual(failureSignature(pytest(3)), failureSignature(pytest(3).replace("1 failed", "2 failed")), "a changed failure count still counts");
	assert.notEqual(failureSignature("exit code 1\nsomething odd happened"), failureSignature("exit code 1\nsomething else happened"), "unknown runners: the end of the output still counts");
});
