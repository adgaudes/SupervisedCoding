// Unit tests of changes.ts: per-delegation checkpoints and diffs on a real Git repository.
// Run: node --test tests/changes.test.ts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { changesSince, checkpoint } from "../changes.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "supervised-coding-changes-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

function repo(files: Record<string, string>): string {
	const dir = fs.mkdtempSync(path.join(root, "repo-"));
	for (const [file, content] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
		fs.writeFileSync(path.join(dir, file), content);
	}
	const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
	git("init", "-q");
	git("add", "-A");
	git("-c", "user.email=t@t", "-c", "user.name=t", "-c", "core.autocrlf=false", "commit", "-q", "-m", "init", "--allow-empty");
	// Hand back the path Git reports, not the one just created: the extension compares the Git root with cwd and
	// with the authorized paths as text, and Git answers with the real, long-form path. A temp root that is an 8.3
	// short name (the Windows CI runners) or a symlink (/tmp on macOS) would otherwise make the two differ, and the
	// walk from the root down to an authorized path would stop before reaching any nested AGENTS.md.
	return path.resolve(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, encoding: "utf8" }).trim());
}

test("the diff shows only what changed after the checkpoint, including new and deleted files", async () => {
	const dir = repo({ "src/a.txt": "one\ntwo\n", "src/b.txt": "keep\n", "src/c.txt": "remove me\n" });
	fs.writeFileSync(path.join(dir, "src/a.txt"), "PRE\ntwo\n"); // Uncommitted before the delegation: not its change.
	const before = await checkpoint(dir, ["src"]);
	fs.writeFileSync(path.join(dir, "src/a.txt"), "PRE\nNEW\n");
	fs.writeFileSync(path.join(dir, "src/new.txt"), "created\n");
	fs.rmSync(path.join(dir, "src/c.txt"));
	const changes = await changesSince(dir, ["src"], before, 60_000);
	assert.deepEqual([...changes.files].sort(), ["src/a.txt", "src/c.txt", "src/new.txt"]);
	assert.equal(changes.complete, true);
	assert.match(changes.diff, /-two[\s\S]*\+NEW/);
	assert.doesNotMatch(changes.diff, /^[-+]PRE/m);
	assert.match(changes.diff, /--- \/dev\/null\n\+\+\+ b\/src\/new\.txt/);
	assert.match(changes.diff, /--- a\/src\/c\.txt\n\+\+\+ \/dev\/null/);
});

test("no change is reported as such", async () => {
	const dir = repo({ "a.txt": "same\n" });
	const before = await checkpoint(dir, ["a.txt"]);
	const changes = await changesSince(dir, ["a.txt"], before, 60_000);
	assert.deepEqual(changes.files, []);
	assert.match(changes.diff, /no changes in the authorized paths/);
});

test("a binary change makes the change set incomplete", async () => {
	const dir = repo({ "bin.dat": "text\n" });
	const before = await checkpoint(dir, ["bin.dat"]);
	fs.writeFileSync(path.join(dir, "bin.dat"), Buffer.from([0, 1, 2, 3]));
	const changes = await changesSince(dir, ["bin.dat"], before, 60_000);
	assert.equal(changes.complete, false);
	assert.deepEqual(changes.omitted, ["bin.dat"]);
	assert.match(changes.diff, /Binary change: bin\.dat/);
});

test("an oversized diff is truncated, marked incomplete, and lists the files it could not show", async () => {
	const dir = repo({ "a.txt": "x\n", "b.txt": "x\n" });
	const before = await checkpoint(dir, ["a.txt", "b.txt"]);
	fs.writeFileSync(path.join(dir, "a.txt"), "y\n".repeat(5_000));
	fs.writeFileSync(path.join(dir, "b.txt"), "z\n");
	const changes = await changesSince(dir, ["a.txt", "b.txt"], before, 500);
	assert.equal(changes.complete, false);
	assert.match(changes.diff, /\[Diff truncated; inspect listed files\.\]$/);
	assert.ok(changes.omitted.includes("b.txt"), "files after the cut are listed as omitted");
});

test("untracked files enter a diff bounded, and a binary one only by name", async () => {
	const { untrackedDiffs, UNTRACKED_FILE_MAX_BYTES } = await import("../git-safety.ts");
	const dir = repo({ "tracked.txt": "x" });
	fs.writeFileSync(path.join(dir, "big.txt"), "a".repeat(UNTRACKED_FILE_MAX_BYTES * 3));
	fs.writeFileSync(path.join(dir, "blob.bin"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
	const diffs = await untrackedDiffs(dir, []);
	const big = diffs.find((item) => item.includes("big.txt"))!;
	assert.ok(big.length < UNTRACKED_FILE_MAX_BYTES * 1.2, `bounded: ${big.length} bytes`);
	assert.match(big, /untracked file truncated: first \d+ of \d+ bytes shown/);
	const blob = diffs.find((item) => item.includes("blob.bin"))!;
	assert.match(blob, /binary, 7 bytes/);
	assert.doesNotMatch(blob, /\+\u0089/, "binary bytes never reach the diff");
});
