#!/bin/zsh
set -euo pipefail
macosRoot="${0:A:h:h}"
buildRoot="$macosRoot/.build"
export CLANG_MODULE_CACHE_PATH="$buildRoot/clang-cache"
export SWIFT_MODULE_CACHE_PATH="$buildRoot/swift-cache"
mkdir -p "$buildRoot/OpenAll.iconset"
for size in 16 32 128 256 512; do
    sips -z "$size" "$size" "$macosRoot/Resources/OpenAll-icon.png" --out "$buildRoot/OpenAll.iconset/icon_${size}x${size}.png" >/dev/null
    doubled=$((size * 2))
    sips -z "$doubled" "$doubled" "$macosRoot/Resources/OpenAll-icon.png" --out "$buildRoot/OpenAll.iconset/icon_${size}x${size}@2x.png" >/dev/null
done
python3 "$macosRoot/scripts/build_icns.py" "$buildRoot/OpenAll.iconset" "$buildRoot/OpenAll.icns"
xcrun swift "$macosRoot/scripts/MakeMenuIcon.swift" "$buildRoot/MenuIcon.png"
