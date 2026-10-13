// Real install check for the host entry: runs the full env.setup (system
// packages only if missing and sudo works; user-level pieces into
// .e2e/hostdata), then prints the env.check report as JSON. Exit code 1 when
// a user-level item is not ok.
//
//   node scripts/dev-host-setup.mts [--force] [--data-dir DIR]
//
// Node 24 runs this file with type stripping; src/ uses ".js" import
// specifiers (bundler style), so a resolve hook maps them to the .ts sources.
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (/^\.{1,2}\//.test(specifier) && specifier.endsWith(".js")) {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      }
      throw error;
    }
  },
});

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const force = args.includes("--force");
const dataDirFlag = args.indexOf("--data-dir");
const dataDir = dataDirFlag >= 0 ? path.resolve(args[dataDirFlag + 1] ?? "") : path.join(root, ".e2e", "hostdata");

const { hostPaths } = await import("../src/host/paths.js");
const { startSetup, runningSetup } = await import("../src/host/setup.js");
const { readSetupRecord } = await import("../src/host/setup-state.js");
const { checkEnv } = await import("../src/host/env.js");

const paths = hostPaths(dataDir);
console.error(`data dir: ${paths.root}\nruntime:  ${paths.runtimeHash}\nforce:    ${force}`);
const started = Date.now();
await startSetup(paths, { force, chromePath: "" }, null);
const running = runningSetup(paths);
let lastMessage = "";
const ticker = setInterval(async () => {
  const record = await readSetupRecord(paths);
  if (record.message !== lastMessage) {
    lastMessage = record.message;
    console.error(`[${Math.round((Date.now() - started) / 1000)}s] ${record.message}`);
  }
}, 1_000);
await running;
clearInterval(ticker);
const record = await readSetupRecord(paths);
console.error(`setup ${record.phase} in ${Math.round((Date.now() - started) / 1000)}s: ${record.message}`);

const report = await checkEnv(paths, { chromePath: "", gigaamUrl: "" });
console.log(JSON.stringify(report, null, 2));

const USER_LEVEL = ["runtime", "playwright", "uv", "venv", "sherpa-onnx", "vad-model", "speaker-model"];
const bad = report.items.filter((item) => USER_LEVEL.includes(item.id) && !item.ok);
if (bad.length > 0) {
  console.error(`user-level items not ok: ${bad.map((item) => `${item.id} (${item.detail})`).join(", ")}`);
  process.exit(1);
}
console.error("all user-level items ok");
