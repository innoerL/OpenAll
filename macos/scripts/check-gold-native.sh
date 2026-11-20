#!/bin/zsh
set -euo pipefail
macosRoot="${0:A:h:h}"
repoRoot="${macosRoot:h}"
testRoot="$(mktemp -d /tmp/openall-native-gold.XXXXXX)"
trap 'rm -rf "$testRoot"' EXIT
mkdir -p "$testRoot/resources"
cp "$macosRoot/Resources/gold-backend/bootstrap.js" "$testRoot/resources/"
for module in store scheduler sources time currency changes outlook market-context macro-calendar forecast-verification fixture; do
  cp "$repoRoot/shared/gold-core/$module.cjs" "$testRoot/resources/"
done
export CLANG_MODULE_CACHE_PATH="$macosRoot/.build/clang-cache"
export SWIFT_MODULE_CACHE_PATH="$macosRoot/.build/swift-cache"
xcrun swiftc -O -target "$(uname -m)-apple-macosx13.0" \
  "$macosRoot/Sources/GoldService.swift" "$macosRoot/Tests/GoldServiceRegression.swift" \
  -framework AppKit -framework WebKit -framework JavaScriptCore -framework Network -lsqlite3 -o "$testRoot/gold-check"
"$testRoot/gold-check" "$testRoot/resources" "$testRoot/snapshot.json"
node "$macosRoot/Tests/gold-native-reference.cjs" "$testRoot/snapshot.json"
