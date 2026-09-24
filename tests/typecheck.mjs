// Check against the same Pi installation used by the integration harness; no global installs required.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const install = process.env.PI_INSTALL_ROOT ?? path.join(os.homedir(), ".pi", "agent", "install");
const version = fs.readFileSync(path.join(install, "current-version"), "utf8").trim();
const modules = path.join(install, "releases", version, "node_modules");
const config = path.join(root, `.typecheck-${process.pid}.json`);
try {
	fs.writeFileSync(config, JSON.stringify({ compilerOptions: {
		target: "ES2023", module: "ESNext", moduleResolution: "Bundler", noEmit: true, strict: true, skipLibCheck: true,
		allowImportingTsExtensions: true, types: ["node"], paths: {
			"@earendil-works/pi-ai": [path.join(modules, "@earendil-works/pi-ai/dist/index.d.ts")],
			"@earendil-works/pi-coding-agent": [path.join(modules, "@earendil-works/pi-coding-agent/dist/index.d.ts")],
			"typebox": [path.join(modules, "typebox/build/index.d.mts")],
		},
	}, files: ["index.ts", "lib.ts", "learning.ts", "routing.ts", "changes.ts", "outline.ts"] }));
	const result = spawnSync(process.execPath, [path.join(root, "node_modules/typescript/bin/tsc"), "--project", config], { cwd: root, stdio: "inherit", windowsHide: true });
	if (result.error) throw result.error;
	process.exitCode = result.status ?? 1;
} finally { fs.rmSync(config, { force: true }); }
