import assert from "node:assert/strict";
import { test } from "node:test";
import { entryName, formatOutline, formatReferences, outlineSource, outlineSupported } from "../outline.ts";

const TS = `import {
	helper,
	type Helper,
} from "./helper.ts";

export type Mode = "a" | "b";

export interface Options {
	mode: Mode;
}

const LIMIT = 10;

export class Store {
	private items: string[] = [];

	add(item: string): void {
		if (item) {
			this.items.push(item);
		}
	}

	get size(): number {
		return this.items.length;
	}
}

export const build = async (options: Options) => {
	return new Store();
};

test("adds an item", () => {
	assert.ok(true);
});
`;

test("TypeScript: declarations, methods and tests with their ranges and nesting", () => {
	const entries = outlineSource("store.ts", TS);
	assert.deepEqual(entries.map((entry) => [entry.line, entry.end, entry.depth, entry.text]), [
		[6, 6, 0, `export type Mode = "a" | "b";`],
		[8, 10, 0, "export interface Options"],
		[12, 12, 0, "const LIMIT = 10;"],
		[14, 26, 0, "export class Store"],
		[17, 21, 1, "add(item: string): void"],
		[23, 25, 1, "get size(): number"],
		[28, 30, 0, "export const build = async (options: Options) =>"],
		[32, 34, 0, `test("adds an item", () =>`],
	]);
});

test("TypeScript: control flow and calls are not declarations; `type Name,` in an import list is not a type alias", () => {
	const texts = outlineSource("store.ts", TS).map((entry) => entry.text);
	assert.ok(!texts.some((text) => /^(if|this\.|helper|type Helper)/.test(text)), texts.join("\n"));
});

test("Python: ranges follow indentation", () => {
	const source = "import os\n\nclass Repo:\n    def __init__(self):\n        self.path = os.getcwd()\n\n    async def load(self):\n        return 1\n\n\ndef main():\n    Repo()\n";
	assert.deepEqual(outlineSource("repo.py", source).map((entry) => [entry.line, entry.end, entry.depth]), [[3, 8, 0], [4, 5, 1], [7, 8, 1], [11, 12, 0]]);
});

test("Markdown: headings nest by level, code fences are skipped", () => {
	const source = "# Title\n\nIntro\n\n## Install\n\n```sh\n# not a heading\n```\n\n## Use\n\nText\n";
	assert.deepEqual(outlineSource("README.md", source).map((entry) => [entry.line, entry.end, entry.depth, entry.text]), [
		[1, 13, 0, "# Title"],
		[5, 9, 1, "## Install"],
		[11, 13, 1, "## Use"],
	]);
});

test("formatOutline: header with the line count, unsupported types and files without declarations say so", () => {
	const text = formatOutline("store.ts", TS);
	assert.match(text.split("\n")[0], /^store\.ts \(34 lines\)$/);
	assert.match(text, /^ {2,}17-21 {2,}add\(item: string\): void$/m);
	assert.equal(outlineSupported("data.json"), false);
	assert.match(formatOutline("data.json", "{}"), /no outline rules/);
	assert.match(formatOutline("empty.ts", "// nothing\n"), /no declarations found/);
});

test("formatOutline: the entry cap is stated", () => {
	const source = Array.from({ length: 5 }, (_, index) => `function f${index}() {}\n`).join("");
	assert.match(formatOutline("many.ts", source, 3), /more than 3 declarations/);
});

test("entryName: identifiers, Go methods, tests and headings", () => {
	assert.equal(entryName("export async function runCheck(ctx: Context): Promise<void>"), "runCheck");
	assert.equal(entryName("func (r *Repo) Load(path string) error"), "Load");
	assert.equal(entryName("add(item: string): void"), "add");
	assert.equal(entryName(`test("adds an item", () =>`), `test "adds an item"`);
	assert.equal(entryName("## Install"), "## Install");
});

test("formatReferences: each use with its enclosing declaration; the declaration itself is marked", () => {
	const matches = [
		{ file: "store.ts", line: 17, text: "\tadd(item: string): void {" },
		{ file: "store.ts", line: 33, text: "\tnew Store().add(\"x\");" },
		{ file: "notes.txt", line: 2, text: "call add first" },
	];
	const text = formatReferences("Store.add", matches, { "store.ts": TS });
	assert.equal(text.split("\n")[0], "Store.add: 3 references in 2 files");
	assert.match(text, /17 {2}declaration: add\(item: string\): void \{/);
	assert.match(text, /33 {2}in test "adds an item": new Store\(\)\.add\("x"\);/);
	assert.match(text, /notes\.txt\n +2 {2}call add first/);
	assert.equal(formatReferences("gone", [], {}), "gone: no references");
});

test("formatReferences: matches beyond the cap are counted, not listed", () => {
	const matches = Array.from({ length: 5 }, (_, index) => ({ file: `f${index}.txt`, line: 1, text: "x" }));
	assert.match(formatReferences("x", matches, {}, 2), /… 3 more in 3 file\(s\)/);
});
