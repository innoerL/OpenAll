#!/bin/zsh
set -euo pipefail
macosRoot="${0:A:h:h}"
sourceRoot="$macosRoot/Sources"
buildRoot="$macosRoot/.build"
appPath="$buildRoot/OpenAll.app"
export CLANG_MODULE_CACHE_PATH="$buildRoot/clang-cache"
export SWIFT_MODULE_CACHE_PATH="$buildRoot/swift-cache"
mkdir -p "$appPath/Contents/MacOS" "$appPath/Contents/Resources"

# main.swift 只在构建目录生成，原始入口保持不变。
cp "$sourceRoot/QuickLaunch.swift" "$buildRoot/main.swift"
sources=("$buildRoot/main.swift")
for name in Enhancements Clipboard ClipboardShelf PasteStack DoubleTapMonitor Pinyin JSONTool JSONFolding GoldService GoldTool GoldEdgeDock TextCompareV2 UnicodeTool AliasEditor SettingsUI FileSearch ExpressionParser MarkdownTool IDGenerator Snippets SnippetEditor Diagnostics Updater SearchRanking SelectionActions TimeResults CommandCenter CommandAliasEditor DeveloperConverter CronExpression BackendModels BackendLogsSQL BackendWorkbench ImageTool PanelMaterial WindowChrome; do
    sources+=("$sourceRoot/$name.swift")
done
frameworks=(-framework AppKit -framework WebKit -framework Carbon -framework ApplicationServices -framework Vision -framework ImageIO -framework UniformTypeIdentifiers -framework JavaScriptCore -framework Network -lsqlite3)

compile() {
    local architecture="$1"
    local destination="$2"
    local optimization="$3"
    xcrun swiftc "$optimization" -j 4 -target "$architecture-apple-macosx13.0" "${sources[@]}" -o "$destination" "${frameworks[@]}"
}

# 开发和压力检查只编译宿主架构；默认生成 Intel 与 Apple Silicon 通用二进制。
if [[ "${OPENALL_REVIEW:-0}" == "1" || "${OPENALL_STRESS:-0}" == "1" ]]; then
    optimization=-Onone
    if [[ "${OPENALL_STRESS:-0}" == "1" ]]; then optimization=-O; fi
    compile "$(uname -m)" "$appPath/Contents/MacOS/OpenAll" "$optimization"
else
    compile x86_64 "$buildRoot/OpenAll-x86_64" -O
    compile arm64 "$buildRoot/OpenAll-arm64" -O
    xcrun lipo -create "$buildRoot/OpenAll-x86_64" "$buildRoot/OpenAll-arm64" -output "$appPath/Contents/MacOS/OpenAll"
fi

zsh "$macosRoot/scripts/build_icons.sh"
cp -R "$macosRoot/Resources/." "$appPath/Contents/Resources/"
cp "$buildRoot/OpenAll.icns" "$buildRoot/MenuIcon.png" "$appPath/Contents/Resources/"
cat > "$appPath/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleDisplayName</key><string>OpenAll</string>
<key>CFBundleExecutable</key><string>OpenAll</string>
<key>CFBundleIdentifier</key><string>local.openall.launcher</string>
<key>CFBundleName</key><string>OpenAll</string>
<key>CFBundleIconFile</key><string>OpenAll.icns</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.27.0</string>
<key>CFBundleVersion</key><string>81</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
<key>NSDesktopFolderUsageDescription</key><string>开启文件搜索后，OpenAll 需要访问桌面文件以显示搜索结果。</string>
<key>NSDocumentsFolderUsageDescription</key><string>开启文件搜索后，OpenAll 需要访问文稿文件以显示搜索结果。</string>
<key>NSDownloadsFolderUsageDescription</key><string>开启文件搜索后，OpenAll 需要访问下载文件以显示搜索结果。</string>
</dict></plist>
PLIST
# 金价由系统 JavaScriptCore/SQLite 执行模型，WebKit 展示，不附带外部运行时。
rm -rf "$appPath/Contents/Helpers"
mkdir -p "$appPath/Contents/Resources/gold-backend" "$appPath/Contents/Resources/gold-ui"
for module in store scheduler sources time currency changes outlook market-context macro-calendar forecast-verification fixture; do
    cp "$macosRoot/../shared/gold-core/$module.cjs" "$appPath/Contents/Resources/gold-backend/"
done
cp "$macosRoot/../shared/gold-ui/"* "$appPath/Contents/Resources/gold-ui/"
codesign --force --deep --sign - "$appPath"
print "已构建 $appPath"
