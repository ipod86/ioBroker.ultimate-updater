// Builds the web components into ../admin/webcomponents/ (module + manifest)
import { build } from "esbuild";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkManifest } from "@iobroker/web-components";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "../admin/webcomponents");
mkdirSync(out, { recursive: true });
for (const name of ["ultimate-updater-table"]) {
	await build({
		entryPoints: [join(here, `${name}.js`)],
		bundle: true,
		format: "esm",
		minify: true,
		target: "es2020",
		outfile: join(out, `${name}.js`),
	});
	const manifest = JSON.parse(readFileSync(join(here, `${name}.json`), "utf8"));
	const problem = checkManifest(manifest);
	if (problem) {
		throw new Error(`${name}.json: ${problem}`);
	}
	copyFileSync(join(here, `${name}.json`), join(out, `${name}.json`));
}
console.log("web components built");
