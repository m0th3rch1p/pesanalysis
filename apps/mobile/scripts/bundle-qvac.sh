#!/usr/bin/env bash
# Regenerate the QVAC worker bundle and link native addons. Idempotent. See docs/plan/_private/11-qvac-phone-lab.md.
# Needs Node ^22.21.0 || >=24.9.0 (bare-pack's lexer addon crashes on older Node).
set -euo pipefail
cd "$(dirname "$0")/.."
node -e 'const s=require("semver");const v=process.versions.node;if(!s.satisfies(v,"^22.21.0 || >=24.9.0")){console.error("Node "+v+" unsupported for bare-pack; need ^22.21.0 || >=24.9.0");process.exit(1)}' 
node scripts/bundle-qvac.mjs "$@"
echo "Now rebuild: cd android && ANDROID_HOME=/ope/android-sdk ./gradlew :app:createBundleReleaseJsAndAssets --rerun-tasks assembleRelease"
