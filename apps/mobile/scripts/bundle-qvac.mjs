// Reproducible QVAC worker bundle for android-arm64 (replaces the Expo plugin's prebuild-time bundling).
// Steps: bundleSdk(qvac.config.json plugins) -> verifyBundle -> copy to @qvac/sdk/dist/worker.mobile.bundle.js
//        -> bare-link the addons the bundle reaches into react-native-bare-kit (android/src/main/addons).
// Run via scripts/bundle-qvac.sh (checks the Node version).
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "..");
const require = createRequire(path.join(appRoot, "package.json"));
const sdkDir = path.dirname(require.resolve("@qvac/sdk/package")); // exports map exposes ./package, not ./package.json
// ROOT CAUSE FIX (Spike 3b was misdiagnosed): bare-pack keys every module by its path RELATIVE TO THE BASE DIR (cwd).
// In an npm-workspaces monorepo @qvac/* is hoisted to <repo>/node_modules, so bundling from apps/mobile yields keys
// like "/../../node_modules/@qvac/sdk/...". bare-module resolves them at runtime as URLs, "file:///../../x" collapses to
// "file:///x", the lookup misses the bundle, falls back to the phone filesystem -> ProtocolError CANNOT_READ -> SIGABRT.
// Bundling with the directory that CONTAINS node_modules as the base gives "/node_modules/@qvac/..." keys that round-trip.
const projectRoot = path.resolve(sdkDir, "..", "..", "..");
const configPath = path.join(appRoot, "qvac.config.json");
const mod = (rel) => import(pathToFileURL(path.join(sdkDir, "dist", "src", rel)).href);

const { bundleSdk, verifyBundle, hasErrors, formatVerifyBundleResult } = await mod("commands/index.js");
const { linkAddons } = await mod("expo/plugins/link-addons.js");
const { createCommandLogger } = await mod("commands/command-logger.js");

// bare-pack takes its base dir from the process cwd (the SDK spawns it without a cwd option)
process.chdir(projectRoot);
const HOSTS = ["android-arm64"];
const DEFER = ["expo-file-system", "react-native-bare-kit", "bare-runtime/spawn", "@qvac/sdk/worker.mobile.bundle"];

const res = await bundleSdk({
  projectRoot,
  configPath,
  sdkPath: sdkDir, // without this the SDK cannot find bare-imports.json in a workspace (package.json is not exported)
  hosts: HOSTS,
  defer: DEFER,
  checkEngines: false,
  installMissingPrebuilds: process.argv.includes("--install-missing-prebuilds"),
});
console.log("plugins:", res.plugins.join(", "));

const verify = await verifyBundle({ projectRoot, configPath, addonsSource: res.bundlePath, hosts: HOSTS, onProgress: (m) => console.log("verify:", m) });
console.log(formatVerifyBundleResult(verify));
if (hasErrors(verify)) throw new Error("bundle verification failed");

// The SDK client requires "@qvac/sdk/worker.mobile.bundle" = a CommonJS module exporting the bundle as a string.
// Same wrapping the SDK's own withMobileBundle does (a plain copy of worker.bundle.js).
fs.copyFileSync(res.bundlePath, path.join(sdkDir, "dist", "worker.mobile.bundle.js"));
// keep the reviewed artifacts next to the app (tracked): bundle + entry + addon manifest
for (const f of ["worker.bundle.js", "worker.entry.mjs", "addons.manifest.json"]) fs.copyFileSync(path.join(projectRoot, "qvac", f), path.join(appRoot, "qvac", f));
const linked = await linkAddons({ projectRoot, entryPath: res.entryPaths.worker, hosts: HOSTS, logger: createCommandLogger({}) });
console.log(`linked ${linked.length} addon files into react-native-bare-kit`);
for (const f of linked) console.log("  ", path.basename(f));
fs.rmSync(path.join(projectRoot, "qvac"), { recursive: true, force: true });
