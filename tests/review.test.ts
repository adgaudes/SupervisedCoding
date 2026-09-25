import assert from "node:assert/strict";
import { test } from "node:test";
import { declarationName } from "../outline.ts";
import { compressPaths, enclosingRanges, formatFinding, hunkRanges, mapLimit, mergeFindings, packShards, parseFindings, parseVerification, renderRanges, splitDiff, touchedDeclarations } from "../review.ts";

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -3,7 +3,7 @@ export function total(items: number[]) {
 	let sum = 0;
-export function scale(value: number) {
+export function scale(value: number, factor = 2) {
 	return value * 2;
@@ -40 +40,2 @@
+const EXTRA = 1;
diff --git a/src/old.ts b/src/old.ts
deleted file mode 100644
--- a/src/old.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-export const gone = 1;
-
diff --git a/new.txt b/new.txt
new file (untracked)
+++ b/new.txt
+hello
`;

test("a diff splits per file, with the new-side name and hunk ranges", () => {
	const files = splitDiff(DIFF);
	assert.deepEqual(files.map((item) => item.file), ["src/a.ts", "src/old.ts", "new.txt"]);
	assert.deepEqual(hunkRanges(files[0].text), [[3, 9], [40, 41]]);
	assert.deepEqual(hunkRanges(files[1].text), [[1, 1]], "a pure deletion marks where it happened");
	assert.deepEqual(hunkRanges(files[2].text), [], "an untracked file is shown whole");
});

test("declarations touched by a diff: changed signatures first, then changed bodies", () => {
	assert.equal(declarationName("a.ts", "export function scale(value: number) {"), "scale");
	assert.equal(declarationName("a.ts", "\treturn value * 2;"), undefined);
	assert.equal(declarationName("a.ts", 'test("scales", () => {'), undefined, "tests are not declarations to look up");
	assert.equal(declarationName("notes.md", "# Title"), undefined);
	const source = ["export function scale(value: number, factor = 2) {", "\treturn value * factor;", "}", "", "export function other() {", "\tconst x = 1;", "\treturn x;", "}"].join("\n");
	const diff = { file: "src/a.ts", text: "@@ -1,3 +1,3 @@\n-export function scale(value: number) {\n+export function scale(value: number, factor = 2) {\n@@ -6,1 +6,1 @@\n-\tconst x = 0;\n+\tconst x = 1;\n" };
	assert.deepEqual(touchedDeclarations(diff, source), { signatures: ["scale"], bodies: ["other"] });
});

test("the code around a change: its declaration, a window inside a long one, nothing at top level", () => {
	const small = ["import x from \"x\";", "", "export function small() {", "\tconst a = 1;", "\tconst b = 2;", "\tconst c = 3;", "\treturn a + b + c;", "}"].join("\n");
	assert.deepEqual(enclosingRanges("a.ts", small, [[5, 5]]), [[3, 8]]);
	assert.deepEqual(enclosingRanges("a.ts", small, [[1, 1]]), [], "top-level code is fully shown by the diff");
	assert.deepEqual(enclosingRanges("a.ts", small, [[3, 8]]), [], "a hunk that already covers the declaration adds nothing");
	const long = ["export function long() {", ...Array.from({ length: 300 }, (_, index) => `\tstep(${index});`), "}"].join("\n");
	assert.deepEqual(enclosingRanges("a.ts", long, [[150, 152]], 150, 30), [[120, 182]]);
	assert.deepEqual(enclosingRanges("a.txt", small, [[5, 5]]), [], "no rules, no ranges");
	assert.equal(renderRanges("a.ts", small, [[3, 4]]), "a.ts:3-4\n3| export function small() {\n4| \tconst a = 1;");
});

test("findings in the line format are parsed; other lines, risks and the verdict are told apart", () => {
	const parsed = parseFindings([
		"Here is my review.",
		"- [MAJOR] src/a.ts:12 — divides by zero when empty — guard the length",
		"1. **[MINOR]** `src/b.ts:4-6` - unclear name - rename",
		"- [MAJOR] the whole design is racy — add a lock",
		"Risk: not run on Windows",
		"No findings.",
		"VERDICT: MAJOR",
	].join("\n"), "rev");
	assert.deepEqual(parsed.findings.map((item) => [item.severity, item.file, item.line]), [["MAJOR", "src/a.ts", 12], ["MINOR", "src/b.ts", 4], ["MAJOR", "", undefined]]);
	assert.equal(parsed.findings[0].text, "divides by zero when empty — guard the length");
	assert.equal(parsed.findings[0].source, "rev");
	assert.deepEqual(parsed.risks, ["not run on Windows"]);
	assert.deepEqual(parsed.other, ["Here is my review."]);
});

test("merged findings are deduplicated by location and listed MAJOR first", () => {
	const merged = mergeFindings([
		[{ severity: "MINOR", file: "a.ts", line: 1, text: "x" }, { severity: "MAJOR", file: "a.ts", line: 9, text: "y" }],
		[{ severity: "MAJOR", file: "a.ts", line: 9, text: "same place, other words" }, { severity: "MAJOR", file: "", text: "General issue" }],
	]);
	assert.deepEqual(merged.map((item) => `${item.severity}:${item.file}:${item.line ?? ""}`), ["MAJOR:a.ts:9", "MAJOR::", "MINOR:a.ts:1"]);
	assert.equal(formatFinding({ ...merged[0], status: "confirmed" }, 1), "- #1 [MAJOR] (confirmed) a.ts:9 — y");
});

test("verification answers are read per finding number", () => {
	const statuses = parseVerification("#1 CONFIRMED — real\n- #2 REJECTED: the bound is checked at line 4\n3. UNSURE — no test\n#4 MINOR — real but harmless\nnoise");
	assert.deepEqual([...statuses].map(([index, item]) => [index, item.status]), [[1, "confirmed"], [2, "rejected"], [3, "unsure"], [4, "minor"]]);
	assert.equal(statuses.get(2)?.reason, "the bound is checked at line 4");
});

test("shards keep order, respect the budget, and grow it to stay within the shard limit", () => {
	const items = [10, 10, 10, 10, 10].map((bytes, index) => ({ bytes, index }));
	assert.deepEqual(packShards(items, 20, 10).map((shard) => shard.map((item) => item.index)), [[0, 1], [2, 3], [4]]);
	const capped = packShards(items, 20, 2);
	assert.ok(capped.length <= 2);
	assert.deepEqual(capped.flat().map((item) => item.index), [0, 1, 2, 3, 4]);
	assert.deepEqual(packShards([{ bytes: 500 }], 20, 3).length, 1, "an item larger than the budget gets a shard of its own");
});

test("a shard's files are written as directories when it holds all of them", () => {
	const inventory = ["a/x.ts", "a/y.ts", "a/sub/z.ts", "b/one.ts", "b/two.ts", "root.ts"];
	assert.deepEqual(compressPaths(["a/x.ts", "a/y.ts", "a/sub/z.ts", "b/one.ts"], inventory), ["a", "b/one.ts"]);
	assert.deepEqual(compressPaths(["root.ts"], inventory), ["root.ts"]);
});

test("mapLimit keeps order and never runs more than the limit at once", async () => {
	let running = 0;
	let peak = 0;
	const results = await mapLimit([5, 1, 3, 2], 2, async (value) => {
		running++;
		peak = Math.max(peak, running);
		await new Promise((resolve) => setTimeout(resolve, value));
		running--;
		return value * 10;
	});
	assert.deepEqual(results, [50, 10, 30, 20]);
	assert.equal(peak, 2);
});
