import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Verification commands (VERIFY lines, run_verification, verificationCommands) run without a shell. Their text is
 * parsed strictly into an executable and its arguments: whitespace separates arguments, single or double quotes group
 * an argument that contains spaces (kept exactly as written), and nothing else is interpreted. Backslashes are
 * literal, so Windows paths need no escaping.
 */

/** Shell metacharacters that could chain or redirect commands: rejected anywhere in a command, quoted or not. */
export const UNSAFE_COMMAND_CHARS = /[;&|`$<>\r\n%^()]/;
/** Any line terminator, Unicode line and paragraph separators included. */
const LINE_BREAK = /[\r\n\v\f\x85\p{Zl}\p{Zp}]/u;
const CONTROL_CHAR = /[\x00-\x08\x0e-\x1f\x7f]/;

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Arguments of one command, the executable first. Throws the reason when the command is malformed or uses shell syntax. */
export function parseCommand(command: string): string[] {
	if (LINE_BREAK.test(command)) throw new Error("line breaks are not allowed: pass one command");
	if (UNSAFE_COMMAND_CHARS.test(command)) throw new Error("shell operators, redirections and variables are not allowed");
	if (CONTROL_CHAR.test(command)) throw new Error("control characters are not allowed");
	const argv: string[] = [];
	let current: string | undefined;
	let quote: string | undefined;
	for (const char of command) {
		if (quote) {
			if (char === quote) quote = undefined;
			else current = (current ?? "") + char;
		} else if (char === '"' || char === "'") {
			quote = char;
			current ??= "";
		} else if (/\s/.test(char)) {
			if (current !== undefined) argv.push(current);
			current = undefined;
		} else {
			current = (current ?? "") + char;
		}
	}
	if (quote) throw new Error(`unterminated ${quote === '"' ? "double" : "single"} quote`);
	if (current !== undefined) argv.push(current);
	if (!argv.length) throw new Error("the command is empty");
	if (!argv[0]) throw new Error("the executable is empty");
	return argv;
}

function quoteArgument(arg: string): string {
	if (arg && !/[\s'"]/.test(arg)) return arg;
	if (!arg.includes('"')) return `"${arg}"`;
	if (!arg.includes("'")) return `'${arg}'`;
	return arg.split('"').map((part) => `"${part}"`).join(`'"'`);
}

/** Canonical text of a command: arguments joined by one space, quoted only when needed. parseCommand reads it back unchanged. */
export function formatCommand(argv: readonly string[]): string {
	return argv.map(quoteArgument).join(" ");
}

/** Parse allowlisted command prefixes (verificationCommands); throws naming the first malformed one. */
export function parseAllowlist(prefixes: readonly unknown[]): string[][] {
	return prefixes.map((prefix) => {
		if (typeof prefix !== "string") throw new Error(`Invalid verificationCommands entry ${JSON.stringify(prefix)}: not a string`);
		try {
			return parseCommand(prefix);
		} catch (error) {
			throw new Error(`Invalid verificationCommands entry ${JSON.stringify(prefix)}: ${messageOf(error)}`);
		}
	});
}

/** Allowlisted = begins with an allowlisted command argument by argument: "npm test -- x" matches "npm test", "npm tester" does not. */
export function allowlisted(argv: readonly string[], allowedPrefixes: readonly string[]): boolean {
	return allowedPrefixes.some((prefix) => {
		let tokens: string[];
		try {
			tokens = parseCommand(prefix);
		} catch {
			return false;
		}
		return tokens.length <= argv.length && tokens.every((token, index) => token === argv[index]);
	});
}

/**
 * The decision taken before any verification command runs, VERIFY and run_verification alike: the command parses and
 * is allowlisted. Returns its canonical text and arguments; throws a clear error otherwise.
 */
export function verificationCommand(command: string, allowedPrefixes: readonly string[]): { command: string; argv: string[] } {
	let argv: string[];
	try {
		argv = parseCommand(command);
	} catch (error) {
		throw new Error(`Rejected verification command ${JSON.stringify(command)}: ${messageOf(error)}. Verification runs without a shell: pass one plain command, quoting arguments that contain spaces.`);
	}
	const canonical = formatCommand(argv);
	if (!allowlisted(argv, allowedPrefixes)) {
		throw new Error(`Command not allowlisted: ${canonical}. It must begin, argument by argument, with one of: ${allowedPrefixes.join(", ")} (verificationCommands in config.json).`);
	}
	return { command: canonical, argv };
}

/**
 * Words of a command line with their quotes kept, for cleaning guide text: whitespace inside quotes does not split.
 * Lenient: an unterminated quote runs to the end (parseCommand rejects it later).
 */
export function splitWords(command: string): string[] {
	const words: string[] = [];
	let current = "";
	let quote: string | undefined;
	for (const char of command) {
		if (quote) {
			current += char;
			if (char === quote) quote = undefined;
		} else if (/\s/.test(char)) {
			if (current) words.push(current);
			current = "";
		} else {
			if (char === '"' || char === "'") quote = char;
			current += char;
		}
	}
	if (current) words.push(current);
	return words;
}

export interface Launch {
	command: string;
	args: string[];
}

export interface LauncherHost {
	platform: NodeJS.Platform;
	env: Record<string, string | undefined>;
	isFile(file: string): boolean;
	readFile(file: string): string;
}

const nodeHost: LauncherHost = {
	platform: process.platform,
	env: process.env,
	isFile: (file) => {
		try {
			return fs.statSync(file).isFile();
		} catch {
			return false;
		}
	},
	readFile: (file) => fs.readFileSync(file, "utf8"),
};

/** Package managers whose Windows launchers are usually batch files, which only cmd.exe can start. */
const PACKAGE_MANAGERS = new Set(["npm", "npx", "pnpm", "yarn"]);
/** cmd-shim (npm -g, corepack) and Yarn's yarn.cmd: `"%_prog%"  "%dp0%\…\cli.js" %*` or `node "%~dp0\yarn.js" %*`. */
const SHIM_TARGET = /(?:"%_prog%"|(?:^|[\s@&])node(?:\.exe)?)\s+"%(?:~dp0|dp0%)\\?([^"%*?<>|]+\.[cm]?js)"\s+%\*/im;
const SHIM_NODE_PROGRAM = /SET\s+"_prog=(?:%dp0%\\)?node(?:\.exe)?"/i;

/**
 * How to start a verification command without a shell. Elsewhere than on Windows, and on Windows for anything but a
 * package manager, the executable is started directly. On Windows npm, npx, pnpm and yarn are resolved on PATH (absolute
 * entries only, never the working directory; .com, .exe, .cmd, .bat in that order): a native launcher is started
 * directly, a batch launcher through the Node script behind it (npm's own CLI next to npm.cmd, or the target of a
 * cmd-shim). Throws when there is no launcher or it is not one of those.
 */
export function resolveLauncher(argv: readonly string[], host: LauncherHost = nodeHost): Launch {
	const [executable, ...args] = argv;
	const name = executable.toLowerCase();
	if (host.platform !== "win32" || !PACKAGE_MANAGERS.has(name)) return { command: executable, args };
	const pathValue = Object.entries(host.env).find(([key]) => key.toUpperCase() === "PATH")?.[1] ?? "";
	const dirs = pathValue.split(";").map((item) => item.trim().replace(/^"(.*)"$/, "$1")).filter((item) => path.win32.isAbsolute(item));
	for (const dir of dirs) {
		for (const extension of [".com", ".exe", ".cmd", ".bat"]) {
			const file = path.win32.join(dir, `${name}${extension}`);
			if (!host.isFile(file)) continue;
			if (extension === ".com" || extension === ".exe") return { command: file, args };
			const node = host.isFile(path.win32.join(dir, "node.exe")) ? path.win32.join(dir, "node.exe") : "node";
			return { command: node, args: [nodeScriptBehind(file, name, host), ...args] };
		}
	}
	throw new Error(`${executable} was not found on PATH (looked for .com, .exe, .cmd and .bat launchers)`);
}

function nodeScriptBehind(shim: string, name: string, host: LauncherHost): string {
	const dir = path.win32.dirname(shim);
	if (name === "npm" || name === "npx") {
		const cli = path.win32.join(dir, "node_modules", "npm", "bin", `${name}-cli.js`);
		if (host.isFile(cli)) return cli;
	}
	let text = "";
	try {
		text = host.readFile(shim);
	} catch {
		// Unreadable: reported below as unsupported.
	}
	const match = SHIM_TARGET.exec(text);
	const runsNode = match && (!match[0].includes("%_prog%") || SHIM_NODE_PROGRAM.test(text));
	const script = match && runsNode ? path.win32.join(dir, match[1]) : undefined;
	if (script && host.isFile(script)) return script;
	throw new Error(`cannot start ${shim} without a shell: only .exe/.com launchers and the Node script behind npm's or cmd-shim's .cmd launchers are supported`);
}
