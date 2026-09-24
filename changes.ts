/** Bounded, non-mutating checkpoints for per-delegation reviews, including untracked files. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
export interface Checkpoint { files: Record<string, Buffer>; complete: boolean; omitted: string[] }
export interface ChangeSet { files: string[]; diff: string; complete: boolean; omitted: string[] }

export async function checkpoint(cwd: string, paths: string[], maxBytes = 20_000_000): Promise<Checkpoint> {
	const result: Checkpoint = { files: {}, complete: true, omitted: [] };
	let names: string[];
	try { names = (await exec("git", ["--literal-pathspecs", "ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", ...paths], { cwd, maxBuffer: 5_000_000 })).stdout.split("\0").filter(Boolean); }
	catch { return { files: {}, complete: false, omitted: ["Git file inventory unavailable"] }; }
	const root = fs.realpathSync(cwd);
	let total = 0;
	for (const name of new Set(names)) {
		const absolute = path.resolve(cwd, name);
		try {
			const real = fs.realpathSync(absolute);
			if (!real.startsWith(root + path.sep)) throw new Error("outside workspace");
			const stat = fs.statSync(real);
			if (!stat.isFile() || stat.size + total > maxBytes) throw new Error("checkpoint limit or unsupported file");
			const data = fs.readFileSync(real);
			total += data.length;
			result.files[name] = data;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			result.complete = false; result.omitted.push(name);
		}
	}
	return result;
}

export async function changesSince(cwd: string, paths: string[], before: Checkpoint, maxBytes: number): Promise<ChangeSet> {
	const after = await checkpoint(cwd, paths);
	const files = [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])].filter(name => {
		const a = before.files[name], b = after.files[name];
		return (a === undefined) !== (b === undefined) || Boolean(a && b && !a.equals(b));
	});
	const result: ChangeSet = { files, diff: "", complete: before.complete && after.complete, omitted: [...before.omitted, ...after.omitted] };
	const temp = fs.mkdtempSync(path.join(os.tmpdir(), "supervised-diff-"));
	try {
		for (const name of files) {
			const a = before.files[name], b = after.files[name];
			if (a?.includes(0) || b?.includes(0)) { result.complete = false; result.omitted.push(name); result.diff += `Binary change: ${name}\n`; continue; }
			fs.writeFileSync(path.join(temp, "before"), a ?? ""); fs.writeFileSync(path.join(temp, "after"), b ?? "");
			let diff = "";
			try { diff = (await exec("git", ["diff", "--no-index", "--no-ext-diff", "--no-color", "--unified=4", "--", "before", "after"], { cwd: temp, maxBuffer: 25_000_000 })).stdout; }
			catch (error) { const err = error as { code?: number; stdout?: string }; if (err.code === 1) diff = err.stdout ?? ""; else { result.complete = false; result.omitted.push(name); } }
			result.diff += diff.replace(/^diff --git .*$/m, `diff --git a/${name} b/${name}`).replace(/^--- .*$/m, a ? `--- a/${name}` : "--- /dev/null").replace(/^\+\+\+ .*$/m, b ? `+++ b/${name}` : "+++ /dev/null");
			if (!diff && (!a || !b)) result.diff += `${a ? "Deleted" : "New"} empty file: ${name}\n`;
			if (Buffer.byteLength(result.diff) > maxBytes) { result.diff = Buffer.from(result.diff).subarray(0, maxBytes).toString("utf8") + "\n[Diff truncated; inspect listed files.]"; result.complete = false; result.omitted.push(...files.slice(files.indexOf(name) + 1)); break; }
		}
	} finally {
		// Only our two known temporary files; never recurse over a computed target.
		fs.rmSync(path.join(temp, "before"), { force: true }); fs.rmSync(path.join(temp, "after"), { force: true }); fs.rmdirSync(temp);
	}
	result.diff ||= "(no changes in the authorized paths during this delegation)";
	return result;
}
