// Resolve Pi's packages (typebox, @earendil-works/*) from the local Pi install, as Pi does when it loads the extension.
// Usage: node --import ./tests/resolve-pi.mjs --test tests/integration.test.ts
import * as fs from "node:fs";
import { registerHooks } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const installRoot = process.env.PI_INSTALL_ROOT ?? path.join(os.homedir(), ".pi", "agent", "install");
const version = fs.readFileSync(path.join(installRoot, "current-version"), "utf8").trim();
const nodeModules = path.join(installRoot, "releases", version, "node_modules");
const parentURL = pathToFileURL(path.join(nodeModules, "resolver.js")).href;

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "typebox" || specifier.startsWith("typebox/") || specifier.startsWith("@earendil-works/")) {
			return nextResolve(specifier, { ...context, parentURL });
		}
		return nextResolve(specifier, context);
	},
});
