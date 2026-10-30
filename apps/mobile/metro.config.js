// Expo SDK 52+ auto-configures monorepo (npm workspaces) resolution.
// We add one rule: @yako/core is written with NodeNext-style `.js` import
// specifiers (`export * from "./types.js"`) so that tsx/tsc resolve it in Node.
// Metro does not rewrite those, so retry without the extension and let
// Metro's normal sourceExts (.ts/.tsx/...) find the real file.
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

config.resolver.resolveRequest = (context, moduleName, platform) => {
  // @qvac/sdk statically imports the optional peer `expo-device` (guarded at runtime by
  // requireOptionalNativeModule("ExpoDevice")). We do not ship it; resolve to an empty module.
  if (moduleName === "expo-device") return { type: "empty" };
  if (moduleName.startsWith(".") && moduleName.endsWith(".js")) {
    try {
      return context.resolveRequest(context, moduleName.slice(0, -3), platform);
    } catch {
      // fall through to the original specifier
    }
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
