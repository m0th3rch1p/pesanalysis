/**
 * Minimal QVAC native wiring (replaces "@qvac/sdk/expo-plugin").
 *
 * Why not the SDK plugin: it re-runs bundleSdk for ALL mobile hosts (incl. iOS) during prebuild and rewrites
 * node_modules. Bundling is done explicitly by scripts/bundle-qvac.sh instead (reproducible, android-arm64 only).
 * This plugin only applies the Android project edits the SDK plugin makes: NDK 29 (addon ABI), arm64-only,
 * libOpenCL.so manifest entry + packaging exclusion; plus an opt-in to drop the GPU ggml backends from the APK.
 *
 * Options: { dropGpuBackends: boolean }  -> excludes libqvac-ggml-vulkan.so / libqvac-ggml-opencl.so (CPU-only, D26).
 */
const { withAppBuildGradle } = require("@expo/config-plugins");

module.exports = function withQvac(config, options = {}) {
  const dir = require("path").dirname(require.resolve("@qvac/sdk/package")) + "/dist/src/expo/plugins/";
  const load = (f) => require(dir + f).default;
  if (options.dropGpuBackends) {
    config = withAppBuildGradle(config, (cfg) => {
      const marker = "// qvac: drop GPU backends";
      if (!cfg.modResults.contents.includes(marker)) {
        cfg.modResults.contents = cfg.modResults.contents.replace(
          /excludes \+= "\/lib\/\*\*\/libOpenCL\.so"/,
          `excludes += "/lib/**/libOpenCL.so"\n            ${marker}\n            excludes += "/lib/**/libqvac-ggml-vulkan.so"\n            excludes += "/lib/**/libqvac-ggml-opencl.so"`,
        );
      }
      return cfg;
    });
  }
  config = load("withAndroidNdkVersion.js")(config);
  config = load("withAndroidArchitecture.js")(config);
  config = load("withOpenCL.js")(config);
  return config;
};
