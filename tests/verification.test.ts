// Run with: node --test tests/verification.test.ts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import { allowlisted, formatCommand, parseAllowlist, parseCommand, resolveLauncher, splitWords, verificationCommand, type LauncherHost } from "../verification.ts";

const PREFIXES = ["npm test", "npm run lint", "npx tsc", "node --test", "python -m pytest"];

test("parseCommand: whitespace separates arguments, quotes group them and keep their spaces", () => {
	assert.deepEqual(parseCommand("npm test"), ["npm", "test"]);
	assert.deepEqual(parseCommand("  npm\ttest   -- --grep  parser "), ["npm", "test", "--", "--grep", "parser"]);
	assert.deepEqual(parseCommand('npm test -- --grep "a  b"'), ["npm", "test", "--", "--grep", "a  b"]);
	assert.deepEqual(parseCommand("pytest -k 'x or y'"), ["pytest", "-k", "x or y"]);
	assert.deepEqual(parseCommand('node --test --test-name-pattern="it\'s ok"'), ["node", "--test", "--test-name-pattern=it's ok"]);
	assert.deepEqual(parseCommand('npm test -- ""'), ["npm", "test", "--", ""], "an empty quoted argument is kept");
	assert.deepEqual(parseCommand("pytest tests\\unit\\a.py"), ["pytest", "tests\\unit\\a.py"], "backslashes are literal");
	assert.deepEqual(parseCommand("go test ./..."), ["go", "test", "./..."]);
});

test("parseCommand: malformed commands and shell syntax are rejected, quoted or not", () => {
	assert.throws(() => parseCommand('npm test -- --grep "a b'), /unterminated double quote/);
	assert.throws(() => parseCommand("npm test -- --grep 'a b"), /unterminated single quote/);
	assert.throws(() => parseCommand(""), /empty/);
	assert.throws(() => parseCommand("   "), /empty/);
	assert.throws(() => parseCommand('"" test'), /executable is empty/);
	assert.throws(() => parseCommand("npm test\nrm -rf ."), /line breaks/);
	assert.throws(() => parseCommand("npm test\u2028x"), /line breaks/);
	assert.throws(() => parseCommand("npm test\u0000"), /control characters/);
	for (const command of ["npm test; rm -rf .", "npm test && curl x", "npm test || x", "npm test | tee o", "npm test > out", "npm test < in", "npm test `id`", "npm test $HOME", "npm test %PATH%", "npm test ^& x", "npm test (x)", 'npm test "a;b"', "npm test '$(id)'"]) {
		assert.throws(() => parseCommand(command), /shell operators/, command);
	}
});

test("formatCommand is canonical and parseCommand reads it back unchanged", () => {
	assert.equal(formatCommand(["npm", "test"]), "npm test");
	assert.equal(formatCommand(["npm", "test", "--", "--grep", "a  b"]), 'npm test -- --grep "a  b"');
	for (const argv of [["npm", "test", "--", ""], ["pytest", "-k", 'say "hi"'], ["pytest", "-k", "it's"], ["pytest", "-k", `it's "x"`], ["node", "--test", "a b.test.mjs"]]) {
		assert.deepEqual(parseCommand(formatCommand(argv)), argv, formatCommand(argv));
	}
});

test("allowlist matching is structural, argument by argument", () => {
	assert.ok(allowlisted(parseCommand("npm test"), PREFIXES));
	assert.ok(allowlisted(parseCommand('npm test -- --grep "a b"'), PREFIXES));
	assert.ok(allowlisted(parseCommand('"npm" "test"'), PREFIXES), "quoting does not change the arguments");
	assert.ok(allowlisted(parseCommand("python -m pytest -q"), PREFIXES));
	for (const command of ["npm tester", "npm-test", "npm", "node --testx", "node --test-only", "npx tscx", "python -m pytestx", "npm run lint-fix", "NPM test", '"npm test"']) {
		assert.equal(allowlisted(parseCommand(command), PREFIXES), false, command);
	}
});

test("verificationCommand: one decision with clear errors, canonical text on success", () => {
	assert.deepEqual(verificationCommand("  npm   test  -- --grep  'a  b' ", PREFIXES), { command: 'npm test -- --grep "a  b"', argv: ["npm", "test", "--", "--grep", "a  b"] });
	assert.throws(() => verificationCommand('npm test -- --grep "a b', PREFIXES), /Rejected verification command.*unterminated double quote.*without a shell/);
	assert.throws(() => verificationCommand("npm test && curl evil", PREFIXES), /Rejected verification command.*shell operators/);
	assert.throws(() => verificationCommand("npm tester", PREFIXES), /Command not allowlisted: npm tester\. .*argument by argument/);
	assert.throws(() => verificationCommand("node --testx", PREFIXES), /Command not allowlisted/);
});

test("parseAllowlist validates configured prefixes", () => {
	assert.deepEqual(parseAllowlist(["npm test", "python -m pytest"]), [["npm", "test"], ["python", "-m", "pytest"]]);
	assert.throws(() => parseAllowlist(["npm test", "npm test && x"]), /Invalid verificationCommands entry "npm test && x": shell operators/);
	assert.throws(() => parseAllowlist(['npm test "x']), /unterminated/);
	assert.throws(() => parseAllowlist([""]), /empty/);
	assert.throws(() => parseAllowlist([42]), /not a string/);
});

test("splitWords keeps quoted words whole for guide cleanup", () => {
	assert.deepEqual(splitWords('  npm  test -- --grep "a  should b"  should pass'), ["npm", "test", "--", "--grep", '"a  should b"', "should", "pass"]);
	assert.deepEqual(splitWords("pytest -k 'x y"), ["pytest", "-k", "'x y"], "an unterminated quote runs to the end");
});

function windows(files: Record<string, string>, pathValue: string): LauncherHost {
	const lower = Object.fromEntries(Object.entries(files).map(([file, text]) => [file.toLowerCase(), text]));
	return {
		platform: "win32",
		env: { Path: pathValue },
		isFile: (file) => file.toLowerCase() in lower,
		readFile: (file) => {
			const text = lower[file.toLowerCase()];
			if (text === undefined) throw new Error(`ENOENT ${file}`);
			return text;
		},
	};
}

const NPM_CMD = '@ECHO off\nSET "NODE_EXE=%~dp0\\node.exe"\n"%NODE_EXE%" "%NPM_CLI_JS%" %*\n';
const CMD_SHIM = [
	"@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start", "SETLOCAL", "CALL :find_dp0",
	'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ") ELSE (", '  SET "_prog=node"', "  SET PATHEXT=%PATHEXT:;.JS;=;%", ")",
	"",
	'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\pnpm\\bin\\pnpm.cjs" %*',
].join("\r\n");

test("resolveLauncher: outside Windows, and for other executables, the command starts directly", () => {
	assert.deepEqual(resolveLauncher(["npm", "test"], { ...windows({}, ""), platform: "linux" }), { command: "npm", args: ["test"] });
	assert.deepEqual(resolveLauncher(["node", "--test", "a b.mjs"], windows({}, "")), { command: "node", args: ["--test", "a b.mjs"] });
});

test("resolveLauncher: Windows npm and npx run npm's CLI with Node, never cmd.exe", () => {
	const host = windows({
		"C:\\Program Files\\nodejs\\npm.cmd": NPM_CMD,
		"C:\\Program Files\\nodejs\\npx.cmd": NPM_CMD,
		"C:\\Program Files\\nodejs\\node.exe": "",
		"C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js": "",
		"C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js": "",
	}, 'C:\\Windows\\system32;"C:\\Program Files\\nodejs";');
	assert.deepEqual(resolveLauncher(["npm", "test", "--", "--grep", "a b"], host), { command: "C:\\Program Files\\nodejs\\node.exe", args: ["C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js", "test", "--", "--grep", "a b"] });
	assert.deepEqual(resolveLauncher(["npx", "tsc", "--noEmit"], host), { command: "C:\\Program Files\\nodejs\\node.exe", args: ["C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js", "tsc", "--noEmit"] });
});

test("resolveLauncher: Windows pnpm and yarn run the Node script behind their cmd-shim, native launchers start directly", () => {
	const shim = windows({
		"C:\\Users\\u\\AppData\\Roaming\\npm\\pnpm.cmd": CMD_SHIM,
		"C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\pnpm\\bin\\pnpm.cjs": "",
		"C:\\Yarn\\bin\\yarn.cmd": '@echo off\r\nnode "%~dp0\\yarn.js" %*\r\n',
		"C:\\Yarn\\bin\\yarn.js": "",
	}, "C:\\Users\\u\\AppData\\Roaming\\npm;C:\\Yarn\\bin");
	assert.deepEqual(resolveLauncher(["pnpm", "test"], shim), { command: "node", args: ["C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\pnpm\\bin\\pnpm.cjs", "test"] });
	assert.deepEqual(resolveLauncher(["yarn", "test"], shim), { command: "node", args: ["C:\\Yarn\\bin\\yarn.js", "test"] });
	const native = windows({ "C:\\pnpm\\pnpm.exe": "", "C:\\later\\pnpm.cmd": CMD_SHIM }, "C:\\pnpm;C:\\later");
	assert.deepEqual(resolveLauncher(["pnpm", "test"], native), { command: "C:\\pnpm\\pnpm.exe", args: ["test"] });
});

test("resolveLauncher: unknown batch launchers, missing launchers and relative PATH entries fail clearly", () => {
	const unknown = windows({ "C:\\tools\\yarn.cmd": "@echo off\r\ncall other.bat %*\r\n" }, "C:\\tools");
	assert.throws(() => resolveLauncher(["yarn", "test"], unknown), /cannot start C:\\tools\\yarn\.cmd without a shell/);
	const otherInterpreter = windows({ "C:\\tools\\pnpm.cmd": CMD_SHIM.replace('SET "_prog=node"', 'SET "_prog=bun"').replace(/node\.exe/g, "bun.exe"), "C:\\tools\\node_modules\\pnpm\\bin\\pnpm.cjs": "" }, "C:\\tools");
	assert.throws(() => resolveLauncher(["pnpm", "test"], otherInterpreter), /without a shell/);
	const missingScript = windows({ "C:\\tools\\pnpm.cmd": CMD_SHIM }, "C:\\tools");
	assert.throws(() => resolveLauncher(["pnpm", "test"], missingScript), /without a shell/);
	assert.throws(() => resolveLauncher(["npm", "test"], windows({}, "C:\\empty")), /npm was not found on PATH/);
	const relative = windows({ "node_modules\\.bin\\npm.exe": "", ".\\npm.exe": "" }, "node_modules\\.bin;.");
	assert.throws(() => resolveLauncher(["npm", "test"], relative), /not found on PATH/, "relative PATH entries depend on the repository and are ignored");
});

test("the shipped allowlist covers the read-only audit and packaging checks, and no mutating form of them", () => {
	const shipped = parseAllowlist(JSON.parse(fs.readFileSync(new URL("../config.json", import.meta.url), "utf8")).verificationCommands);
	const prefixes = shipped.map(formatCommand);
	const allows = (command: string) => allowlisted(parseCommand(command), prefixes);
	assert.ok(allows("npm audit --omit=dev"));
	assert.ok(allows("npm pack --dry-run --json"));
	assert.ok(!allows("npm audit"), "a bare audit is not the allowlisted form");
	assert.ok(!allows("npm audit fix"), "npm audit fix writes to package.json and the lockfile");
	assert.ok(!allows("npm audit fix --omit=dev"));
	assert.ok(!allows("npm pack"), "npm pack without --dry-run writes a tarball into the repository");
	assert.ok(!allows("npm publish"));
});

test("the shipped defaults keep the supervisor able to edit and a worker's turns bounded", () => {
	const config = JSON.parse(fs.readFileSync(new URL("../config.json", import.meta.url), "utf8"));
	for (const tool of ["edit", "write", "read", "delegate_implementation", "run_verification"]) {
		assert.ok(config.supervisorTools.includes(tool), `the supervisor needs ${tool}: a small, fully specified change must not cost a whole worker`);
	}
	// A worker re-reads its context on every turn, so its cost is turns x context: the caps are what bounds it.
	assert.deepEqual(config.workerMaxTurns, { small: 16, medium: 32, large: 64, critical: 96 });
	for (const profile of Object.keys(config.workerMaxTurns)) {
		assert.ok(config.workerMaxTurns[profile] <= 96, profile);
	}
});
