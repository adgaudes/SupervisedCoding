import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Resolve to a real executable: spawning `.cmd` shims with shell:false fails with EINVAL on current Node. */
export function resolveClaudeCommand(configured: string): string {
	if (configured !== "claude" || process.platform !== "win32") return configured;
	const candidates = [
		process.env.APPDATA && path.join(process.env.APPDATA, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"),
		path.join(os.homedir(), ".local", "bin", "claude.exe"),
	].filter((item): item is string => Boolean(item));
	return candidates.find((item) => fs.existsSync(item)) ?? "claude";
}

/** Keep the end of long command output: test runners print failures and summaries last. */
export function truncateUtf8Tail(value: string, maxBytes: number): string {
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
	return `[Output truncated; showing the last ${maxBytes} bytes.]\n${lastBytes(value, maxBytes)}`;
}

export function truncateUtf8(value: string, maxBytes: number): string {
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
	return `${firstBytes(value, maxBytes)}\n\n[Output truncated; inspect the working tree for full details.]`;
}

/** Keep the start and the end of a long report: its context comes first, its conclusions (verdict, risks) last. */
export function truncateUtf8Middle(value: string, maxBytes: number): string {
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
	const head = firstBytes(value, Math.floor(maxBytes * 0.4));
	return `${head}\n\n[… middle omitted …]\n\n${lastBytes(value, maxBytes - Buffer.byteLength(head, "utf8"))}`;
}

export function firstBytes(value: string, maxBytes: number): string {
	let result = value.slice(0, maxBytes);
	while (Buffer.byteLength(result, "utf8") > maxBytes) result = result.slice(0, -1);
	return result;
}

export function lastBytes(value: string, maxBytes: number): string {
	let result = value.slice(-maxBytes);
	while (Buffer.byteLength(result, "utf8") > maxBytes) result = result.slice(1);
	return result;
}

export interface ProcessOutcome {
	exitCode: number;
	stdout: string;
	stderr: string;
	aborted: boolean;
	timedOut: boolean;
	/** The process never started (missing executable, invalid launcher): nothing ran, so exitCode says nothing. */
	launchError?: string;
}

/** Terminate the whole process tree: Windows does not propagate SIGTERM to grandchildren (shells, test runners). */
export function killTree(child: ReturnType<typeof spawn>): void {
	if (child.exitCode !== null || child.signalCode !== null) return;
	if (process.platform === "win32" && child.pid) {
		spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => child.kill());
		return;
	}
	try { if (child.pid) process.kill(-child.pid, "SIGTERM"); else child.kill("SIGTERM"); } catch { child.kill("SIGTERM"); }
	setTimeout(() => {
		try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* Process group has already exited. */ }
	}, 5000).unref();
}

export function runProcess(command: string, args: string[], input: string, cwd: string, signal: AbortSignal | undefined, timeoutMs: number, onLine?: (line: string) => void, options: { shell?: boolean; env?: Record<string, string>; maxBytes?: number } = {}): Promise<ProcessOutcome> {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let buffer = "";
		let aborted = false;
		let timedOut = false;
		let settled = false;
		let started = false;
		let launchError: string | undefined;
		const cap = options.maxBytes ?? 2_000_000;
		const start = () => spawn(command, args, { cwd, shell: options.shell ?? false, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...options.env } });
		let child: ReturnType<typeof start>;
		try {
			child = start();
		} catch (error) {
			// Invalid arguments or a launcher Node refuses (e.g. .cmd without a shell) throw before any process exists.
			const message = `spawn ${command} ${error instanceof Error ? error.message : String(error)}`;
			resolve({ exitCode: 1, stdout: "", stderr: message, aborted: false, timedOut: false, launchError: message });
			return;
		}
		child.on("spawn", () => { started = true; });
		const abort = () => {
			aborted = true;
			killTree(child);
		};
		const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs) : undefined;
		const finish = (code: number) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			if (onLine && buffer.trim()) onLine(buffer);
			resolve({ exitCode: code, stdout, stderr, aborted, timedOut, launchError });
		};
		child.stdout.on("data", (chunk) => {
			const text = chunk.toString();
			if (!onLine) {
				stdout = truncateUtf8Tail(stdout + text, cap);
				return;
			}
			buffer += text;
			if (Buffer.byteLength(buffer) > cap && !buffer.includes("\n")) { stderr += "Worker output line exceeded limit."; killTree(child); return; }
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) onLine(line);
		});
		child.stderr.on("data", (chunk) => { stderr = truncateUtf8Tail(stderr + chunk.toString(), cap); });
		child.on("error", (error) => {
			stderr += `spawn ${command} ${error.message}`;
			if (!started) launchError = error.message;
			finish(1);
		});
		child.on("close", (code) => finish(code ?? 1));
		child.stdin.on("error", (error) => { stderr += error.message; });
		child.stdin.end(input);
		if (signal?.aborted) abort();
		else signal?.addEventListener("abort", abort, { once: true });
	});
}
