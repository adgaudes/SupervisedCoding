import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { truncateUtf8 } from "./process-runner.ts";

const execFile = promisify(execFileCallback);

export async function runGit(cwd: string, args: string[]): Promise<string> {
	try {
		const { stdout, stderr } = await execFile("git", args, { cwd, encoding: "utf8", maxBuffer: 5 * 1024 * 1024 });
		return `${stdout}${stderr}`.trim() || "(no output)";
	} catch (error) {
		const err = error as Error & { stdout?: string; stderr?: string };
		throw new Error(`${err.message}\n${err.stdout || ""}${err.stderr || ""}`.trim());
	}
}

export async function safeRunGit(cwd: string, args: string[]): Promise<{ ok: true; output: string } | { ok: false; error: string }> {
	try {
		return { ok: true, output: await runGit(cwd, args) };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

export function normalizeSupervisorPath(value: string): string {
	const normalized = value.trim().replace(/\\+/g, "/").replace(/^\.\//, "").replace(/\/+/g, "/");
	return normalized === "" ? "." : normalized;
}

export function normalizeAllowedPaths(paths: string[], allowWorkspaceRoot = false): string[] {
	const result: string[] = [];
	for (const raw of paths) {
		const item = normalizeSupervisorPath(raw);
		if (path.isAbsolute(raw) || /^[A-Za-z]:/.test(raw)) throw new Error(`Path allowlist must be repository-relative: ${raw}`);
		if (item.split("/").includes("..")) throw new Error(`Path allowlist cannot contain '..': ${raw}`);
		if (item === "." && !allowWorkspaceRoot) throw new Error("Path allowlist cannot use '.' for normal delegation; list concrete files or directories.");
		if (!result.includes(item)) result.push(item);
	}
	return result;
}

export function pathInAllowedScope(file: string, allowedPaths: string[]): boolean {
	const normalized = normalizeSupervisorPath(file);
	return allowedPaths.some((allowed) => allowed === "." || normalized === allowed || normalized.startsWith(`${allowed.replace(/\/$/, "")}/`));
}

export interface GitSnapshot {
	available: boolean;
	status: string;
	branch?: string;
	head?: string;
	changedFiles: string[];
	stagedFiles: string[];
	/** Raw `git diff --cached` output, including index blob ids, to detect restaging of already-staged files. */
	stagedFingerprint?: string;
	fileHashes: Record<string, string>;
	error?: string;
}

/** Stdout only: stderr warnings (e.g. CRLF notices) must never be parsed as file names. */
export async function gitStdout(cwd: string, args: string[]): Promise<string | undefined> {
	try {
		const { stdout } = await execFile("git", args, { cwd, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
		return stdout;
	} catch {
		return undefined;
	}
}

export function nulSeparated(output: string | undefined): string[] {
	return output ? output.split("\0").filter(Boolean).map(normalizeSupervisorPath) : [];
}

export function fileFingerprint(cwd: string, file: string): string {
	try {
		const absolute = path.join(cwd, file);
		const stat = fs.statSync(absolute);
		if (!stat.isFile()) return stat.isDirectory() ? "(directory)" : "(special)";
		return createHash("sha256").update(fs.readFileSync(absolute)).digest("hex");
	} catch {
		return "(missing)";
	}
}

export async function getGitSnapshot(cwd: string): Promise<GitSnapshot> {
	const status = await safeRunGit(cwd, ["status", "--short", "--branch"]);
	if (!status.ok) return { available: false, status: `(git unavailable: ${status.error})`, changedFiles: [], stagedFiles: [], fileHashes: {}, error: status.error };
	const [branch, head, unstaged, staged, stagedRaw, untracked] = await Promise.all([
		safeRunGit(cwd, ["branch", "--show-current"]), gitStdout(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"]),
		gitStdout(cwd, ["diff", "--name-only", "--relative", "-z", "--"]), gitStdout(cwd, ["diff", "--cached", "--name-only", "--relative", "-z", "--"]),
		gitStdout(cwd, ["diff", "--cached", "--raw", "--no-renames", "--relative", "-z", "--"]), gitStdout(cwd, ["ls-files", "--others", "--exclude-standard", "-z", "--"]),
	]);
	const stagedFiles = nulSeparated(staged);
	const changedFiles = [...new Set([...nulSeparated(unstaged), ...stagedFiles, ...nulSeparated(untracked)])];
	const fileHashes: Record<string, string> = {};
	for (const file of changedFiles) fileHashes[file] = fileFingerprint(cwd, file);
	return {
		available: true,
		status: status.output,
		branch: branch.ok ? branch.output : undefined,
		head: head?.trim() || undefined,
		changedFiles,
		stagedFiles,
		stagedFingerprint: stagedRaw,
		fileHashes,
	};
}

export const CLEAN_FINGERPRINT = "(clean)";

/**
 * Exact identity of the repository state a check runs on: HEAD, branch, index, and the content of every changed or
 * untracked file of the whole repository (a check run from a subdirectory may read files outside it). Files ignored
 * by Git are not covered. Undefined when it cannot be exact: no Git, or an entry that is not a plain file (a nested
 * repository, whose own changes Git does not list).
 */
export async function workingTreeFingerprint(cwd: string): Promise<string | undefined> {
	const top = (await gitStdout(cwd, ["rev-parse", "--show-toplevel"]))?.trim();
	if (!top) return undefined;
	const [head, branch, index, status] = await Promise.all([
		gitStdout(top, ["rev-parse", "--verify", "--quiet", "HEAD"]), gitStdout(top, ["symbolic-ref", "--quiet", "HEAD"]),
		gitStdout(top, ["diff", "--cached", "--raw", "--no-renames", "-z", "--"]), gitStdout(top, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"]),
	]);
	if (index === undefined || status === undefined) return undefined;
	const hash = createHash("sha256").update(`${head ?? ""}\0${branch ?? ""}\0${index}`);
	for (const entry of status.split("\0").filter(Boolean)) {
		const content = fileFingerprint(top, entry.slice(3));
		if (content === "(directory)" || content === "(special)") return undefined;
		hash.update(`\0${entry}\0${content}`);
	}
	return hash.digest("hex");
}

/** Files whose content differs between two snapshots, including pre-existing dirty files. */
export function filesChangedBetween(before: GitSnapshot, after: GitSnapshot): string[] {
	if (!before.available || !after.available) return [];
	return [...new Set([...before.changedFiles, ...after.changedFiles])].filter((file) => (before.fileHashes[file] ?? CLEAN_FINGERPRINT) !== (after.fileHashes[file] ?? CLEAN_FINGERPRINT));
}

export function compareGitSnapshots(before: GitSnapshot, after: GitSnapshot, allowedPaths: string[]): string[] {
	if (!before.available || !after.available) return [];
	const outsideScope = filesChangedBetween(before, after).filter((file) => !pathInAllowedScope(file, allowedPaths));
	const violations: string[] = [];
	if (before.branch !== after.branch && (before.branch || after.branch)) {
		violations.push(`branch changed from ${before.branch ?? "(detached)"} to ${after.branch ?? "(detached)"}`);
	}
	if (before.head !== after.head && (before.head || after.head)) {
		violations.push(`HEAD changed from ${before.head ?? "(none)"} to ${after.head ?? "(none)"}`);
	}
	const beforeStaged = [...before.stagedFiles].sort().join("\n");
	const afterStaged = [...after.stagedFiles].sort().join("\n");
	if (beforeStaged !== afterStaged || before.stagedFingerprint !== after.stagedFingerprint) {
		violations.push(`staged files or staged content changed: ${after.stagedFiles.join(", ") || "none"}`);
	}
	if (outsideScope.length) violations.push(`files outside allowedPaths changed: ${outsideScope.join(", ")}`);
	return violations;
}

/**
 * Diff of the allowed paths against HEAD, plus the full content of new untracked files (git diff omits them).
 * Reviewers and handoffs get the actual change instead of having to reconstruct it.
 */
export async function scopedDiff(cwd: string, paths: string[], maxBytes: number): Promise<string> {
	const scope = paths.length ? paths : ["."];
	const hasHead = Boolean((await gitStdout(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"]))?.trim());
	const tracked = (await gitStdout(cwd, ["-c", "core.quotepath=off", "diff", "--no-ext-diff", "--no-color", "--unified=5", ...(hasHead ? ["HEAD"] : []), "--", ...scope])) ?? "";
	const diff = [tracked.trim(), ...(await untrackedDiffs(cwd, scope))].filter(Boolean).join("\n");
	if (!diff) return "(no changes in the allowed paths)";
	return Buffer.byteLength(diff, "utf8") > maxBytes ? `${truncateUtf8(diff, maxBytes)}\n[Diff truncated at ${maxBytes} bytes: read the listed files for the rest.]` : diff;
}

/** Untracked files as diffs of new files (git diff omits them). */
export async function untrackedDiffs(cwd: string, scope: string[]): Promise<string[]> {
	const untracked = nulSeparated(await gitStdout(cwd, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...scope]));
	const added: string[] = [];
	for (const file of untracked) {
		try {
			const content = fs.readFileSync(path.join(cwd, file), "utf8");
			added.push(`diff --git a/${file} b/${file}\nnew file (untracked)\n+++ b/${file}\n${content.split("\n").map((line) => `+${line}`).join("\n")}`);
		} catch {
			added.push(`new file (untracked, unreadable): ${file}`);
		}
	}
	return added;
}

/** Refs review_changes may compare against (no options, no revision ranges). */
export const SAFE_REF = /^(?!-)[\w./@{}^~-]+$/;

/**
 * The base a branch is reviewed against: the requested ref, else the current branch's upstream, origin/HEAD, main
 * or master; compared from its merge base with HEAD, so only the branch's own changes are reviewed.
 */
export async function resolveReviewBase(cwd: string, requested: string | undefined): Promise<{ ref: string; mergeBase: string }> {
	const candidates = requested ? [requested.trim()] : ["@{upstream}", "origin/HEAD", "origin/main", "origin/master", "main", "master"];
	for (const ref of candidates) {
		if (!SAFE_REF.test(ref) || ref.includes("..")) {
			if (requested) throw new Error(`Not a plain Git ref: ${ref}`);
			continue;
		}
		const commit = (await gitStdout(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]))?.trim();
		const mergeBase = commit ? (await gitStdout(cwd, ["merge-base", commit, "HEAD"]))?.trim() : undefined;
		if (mergeBase) return { ref, mergeBase };
		if (requested) throw new Error(`Unknown Git ref, or no common history with HEAD: ${ref}`);
	}
	throw new Error("No base to compare with (no upstream, origin/HEAD, main or master): pass base, e.g. origin/main.");
}

/** Changes since a merge base: committed ones, plus uncommitted and untracked ones unless only commits are wanted. */
export async function branchDiff(cwd: string, mergeBase: string, paths: string[], uncommitted: boolean): Promise<string> {
	const scope = paths.length ? paths : ["."];
	// --relative: paths from the working directory, like every other path the tools take and return.
	const tracked = await gitStdout(cwd, ["-c", "core.quotepath=off", "diff", "--relative", "--no-ext-diff", "--no-color", "--unified=5", mergeBase, ...(uncommitted ? [] : ["HEAD"]), "--", ...scope]);
	if (tracked === undefined) throw new Error("git diff failed.");
	return [tracked.trim(), ...(uncommitted ? await untrackedDiffs(cwd, scope) : [])].filter(Boolean).join("\n");
}
