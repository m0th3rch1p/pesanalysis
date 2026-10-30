const { withAndroidManifest, withDangerousMod } = require("@expo/config-plugins");
const { mkdirSync, writeFileSync } = require("fs");
const { join } = require("path");

const XML = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <!-- HTTPS everywhere by default. Plain HTTP is allowed only for the
       personal-host loopback; LAN/tunnel hosts must use HTTPS. -->
  <base-config cleartextTrafficPermitted="false"/>
  <domain-config cleartextTrafficPermitted="true">
    <domain includeSubdomains="false">localhost</domain>
    <domain includeSubdomains="false">127.0.0.1</domain>
  </domain-config>
</network-security-config>
`;

module.exports = function withNetworkSecurity(config) {
  config = withAndroidManifest(config, (cfg) => {
    const app = cfg.modResults.manifest.application?.[0];
    if (app) app.$["android:networkSecurityConfig"] = "@xml/network_security_config";
    return cfg;
  });
  config = withDangerousMod(config, ["android", async (cfg) => {
    const dir = join(cfg.modRequest.platformProjectRoot, "app", "src", "main", "res", "xml");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "network_security_config.xml"), XML);
    return cfg;
  }]);
  return config;
};
