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
	return dir;
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
