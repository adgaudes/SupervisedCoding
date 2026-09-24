/**
 * Deterministic outline of source files: declarations with approximate line ranges, so the supervisor reads the
 * ranges it needs instead of whole files. No model calls, no parser: line patterns per language plus indentation,
 * which fits conventionally formatted code.
 */

export interface OutlineEntry {
	/** 1-based first line. */
	line: number;
	/** 1-based last line (approximate: from indentation). */
	end: number;
	/** Nesting level among the entries of the file. */
	depth: number;
	text: string;
}

type Closing = "brace" | "indent" | "heading";
interface Rule { closing: Closing; patterns: RegExp[] }

const JS_KEYWORDS = "if|for|while|switch|catch|return|with|else|do|try|function|new|await|typeof|super|this";
const TEST_CALL = /^\s*(?:test|it|describe|suite)(?:\.\w+)?\(\s*["'`]/;

const JS: Rule = {
	closing: "brace",
	patterns: [
		/^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|interface|enum|namespace|module)\s+[\w$]/,
		// A type alias has its "=" on the first line; `type Name,` inside an import list is not a declaration.
		/^\s*(?:export\s+)?(?:declare\s+)?type\s+[\w$]+\s*(?:<.*>)?\s*=/,
		/^\s*(?:export\s+)?(?:const|let|var)\s+[\w$]+\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[\w$]+\s*=>)/,
		/^(?:export\s+)?const\s+[A-Z][A-Z0-9_]*\s*(?::[^=]+)?=/,
		new RegExp(`^\\s+(?:(?:public|private|protected|static|async|readonly|override|abstract|get|set)\\s+)*(?!(?:${JS_KEYWORDS})\\b)[\\w$]+\\s*(?:<[^>]*>)?\\([^)]*\\)\\s*(?::\\s*[^={]+)?\\{\\s*$`),
		TEST_CALL,
	],
};

const RULES: Record<string, Rule> = {
	ts: JS, tsx: JS, mts: JS, cts: JS, js: JS, jsx: JS, mjs: JS, cjs: JS,
	py: { closing: "indent", patterns: [/^\s*(?:async\s+)?(?:def|class)\s+\w/] },
	go: { closing: "brace", patterns: [/^(?:func|type)\s+/, /^\s*func\s+Test\w*\(/] },
	rs: { closing: "brace", patterns: [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:fn|struct|enum|trait|impl|mod|type|macro_rules!)\b/] },
	java: { closing: "brace", patterns: [/^\s*(?:(?:public|private|protected|static|final|abstract|sealed|synchronized)\s+)*(?:class|interface|enum|record)\s+\w/, /^\s+(?:(?:public|private|protected|static|final|abstract|synchronized)\s+)+[\w<>\[\], ?]+\s+\w+\s*\([^)]*\)\s*(?:throws [\w., ]+)?\{?\s*$/] },
	kt: { closing: "brace", patterns: [/^\s*(?:(?:public|private|internal|protected|open|abstract|sealed|data|inline|override|suspend)\s+)*(?:class|interface|object|fun|enum class)\s+\w/] },
	cs: { closing: "brace", patterns: [/^\s*(?:(?:public|private|internal|protected|static|sealed|abstract|partial|readonly)\s+)*(?:class|interface|struct|enum|record)\s+\w/, /^\s+(?:(?:public|private|internal|protected|static|virtual|override|async|abstract)\s+)+[\w<>\[\], ?]+\s+\w+\s*\([^)]*\)\s*\{?\s*$/] },
	swift: { closing: "brace", patterns: [/^\s*(?:(?:public|private|internal|fileprivate|open|static|final)\s+)*(?:class|struct|enum|protocol|extension|func)\s+\w/] },
	rb: { closing: "indent", patterns: [/^\s*(?:def|class|module)\s+\S/] },
	php: { closing: "brace", patterns: [/^\s*(?:(?:public|private|protected|static|abstract|final)\s+)*(?:function|class|interface|trait|enum)\s+\w/] },
	md: { closing: "heading", patterns: [/^#{1,6}\s+\S/] },
	mdx: { closing: "heading", patterns: [/^#{1,6}\s+\S/] },
};

export function outlineSupported(file: string): boolean {
	return RULES[extensionOf(file)] !== undefined;
}

function extensionOf(file: string): string {
	const match = /\.([A-Za-z0-9]+)$/.exec(file);
	return match ? match[1].toLowerCase() : "";
}

function indentOf(line: string): number {
	let width = 0;
	for (const char of line) {
		if (char === " ") width++;
		else if (char === "\t") width += 4;
		else break;
	}
	return width;
}

/** Declarations of one file, in order, with nesting and approximate ranges. */
export function outlineSource(file: string, source: string, maxEntries = 400): OutlineEntry[] {
	const rule = RULES[extensionOf(file)];
	if (!rule) return [];
	const lines = source.split(/\r?\n/);
	const entries: OutlineEntry[] = [];
	let fence = false;
	for (let index = 0; index < lines.length && entries.length < maxEntries; index++) {
		const line = lines[index];
		if (rule.closing === "heading" && /^\s*(?:```|~~~)/.test(line)) fence = !fence;
		if (fence || !rule.patterns.some((pattern) => pattern.test(line))) continue;
		entries.push({ line: index + 1, end: endOf(lines, index, rule.closing), depth: 0, text: line.trim().replace(/\s*\{\s*$/, "").slice(0, 140) });
	}
	// Nesting: entries whose range encloses this one.
	const open: OutlineEntry[] = [];
	for (const entry of entries) {
		while (open.length && open[open.length - 1].end < entry.line) open.pop();
		entry.depth = open.length;
		open.push(entry);
	}
	return entries;
}

function endOf(lines: string[], start: number, closing: Closing): number {
	if (closing === "heading") {
		const level = /^#+/.exec(lines[start])?.[0].length ?? 1;
		let fence = false;
		for (let index = start + 1; index < lines.length; index++) {
			if (/^\s*(?:```|~~~)/.test(lines[index])) fence = !fence;
			const heading = fence ? undefined : /^(#{1,6})\s+\S/.exec(lines[index]);
			if (heading && heading[1].length <= level) return trimBlank(lines, index - 1, start);
		}
		return trimBlank(lines, lines.length - 1, start);
	}
	const indent = indentOf(lines[start]);
	// A declaration ending on its own line (a type alias, a one-line function) has no body to measure.
	if (closing === "brace" && /[;)}\]]\s*(?:\/\/.*)?$/.test(lines[start]) && !/[{(\[]\s*$/.test(lines[start])) return start + 1;
	for (let index = start + 1; index < lines.length; index++) {
		const line = lines[index];
		if (!line.trim() || indentOf(line) > indent) continue;
		// The first line back at the declaration's indentation closes it ("}", "})", "];") or starts the next one.
		if (closing === "brace" && /^\s*[)}\]]/.test(line)) return index + 1;
		return trimBlank(lines, index - 1, start);
	}
	return trimBlank(lines, lines.length - 1, start);
}

function trimBlank(lines: string[], end: number, start: number): number {
	let index = end;
	while (index > start && !lines[index].trim()) index--;
	return index + 1;
}

/** Text of one file's outline: `path (N lines)` and one indented line per declaration. */
export function formatOutline(file: string, source: string, maxEntries = 400): string {
	const total = source.split(/\r?\n/).length - (/\n$/.test(source) ? 1 : 0);
	const entries = outlineSource(file, source, maxEntries);
	const header = `${file} (${total} lines)`;
	if (!outlineSupported(file)) return `${header}: no outline rules for this file type`;
	if (!entries.length) return `${header}: no declarations found`;
	const width = String(total).length;
	const body = entries.map((entry) => `${"  ".repeat(entry.depth + 1)}${String(entry.line).padStart(width)}-${String(entry.end).padEnd(width)}  ${entry.text}`);
	return [header, ...body, ...(entries.length >= maxEntries ? [`  … more than ${maxEntries} declarations; outline a narrower path`] : [])].join("\n");
}

export interface ReferenceMatch {
	file: string;
	/** 1-based line. */
	line: number;
	text: string;
}

/** Short name of a declaration line: its identifier, a test's title, or a heading. */
export function entryName(text: string): string {
	const goMethod = /^func\s+\([^)]*\)\s*([\w$]+)/.exec(text);
	if (goMethod) return goMethod[1];
	const test = /^(?:test|it|describe|suite)(?:\.\w+)?\(\s*(["'`])(.*?)\1/.exec(text);
	if (test) return `test "${test[2].slice(0, 40)}"`;
	if (/^#{1,6}\s/.test(text)) return text.slice(0, 60);
	const keyword = /\b(?:function\*?|class|interface|type|enum|namespace|module|def|fn|func|struct|trait|impl|mod|object|record|protocol|extension|const|let|var)\s+([\w$.]+)/.exec(text);
	if (keyword) return keyword[1];
	const call = /([\w$]+)\s*(?:<[^>]*>)?\(/.exec(text);
	return call ? call[1] : text.slice(0, 40);
}

/**
 * Where a symbol is used, grouped by file, each line with its innermost enclosing declaration: who uses it, not
 * only where. `sources` holds the text of each file, for the enclosing declarations.
 */
export function formatReferences(symbol: string, matches: ReferenceMatch[], sources: Record<string, string | undefined>, maxMatches = 60): string {
	const files = [...new Set(matches.map((match) => match.file))];
	const header = `${symbol}: ${matches.length} reference${matches.length === 1 ? "" : "s"} in ${files.length} file${files.length === 1 ? "" : "s"}`;
	if (!matches.length) return `${symbol}: no references`;
	const shown = matches.slice(0, maxMatches);
	const lines = [header];
	const name = symbol.split(".").at(-1);
	const width = String(Math.max(...shown.map((match) => match.line))).length;
	for (const file of files) {
		const inFile = shown.filter((match) => match.file === file);
		if (!inFile.length) continue;
		const source = sources[file];
		const entries = source === undefined ? [] : outlineSource(file, source);
		lines.push(`  ${file}`);
		for (const match of inFile) {
			const enclosing = entries.filter((entry) => entry.line <= match.line && match.line <= entry.end).at(-1);
			const where = !enclosing ? "" : enclosing.line === match.line && entryName(enclosing.text) === name ? "declaration: " : `in ${entryName(enclosing.text)}: `;
			lines.push(`    ${String(match.line).padStart(width)}  ${where}${match.text.trim().slice(0, 120)}`);
		}
	}
	if (matches.length > shown.length) {
		const rest = matches.slice(maxMatches);
		lines.push(`  … ${rest.length} more in ${new Set(rest.map((match) => match.file)).size} file(s): pass narrower paths`);
	}
	return lines.join("\n");
}
