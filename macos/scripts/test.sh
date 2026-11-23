#!/bin/zsh
set -euo pipefail
macosRoot="${0:A:h:h}"
sourceRoot="$macosRoot/Sources"
testRoot="$macosRoot/Tests"
buildRoot="$macosRoot/.build/tests"
export CLANG_MODULE_CACHE_PATH="$macosRoot/.build/clang-cache"
export SWIFT_MODULE_CACHE_PATH="$macosRoot/.build/swift-cache"
mkdir -p "$buildRoot"

# 使用生产文件中的纯渲染器，避免为模型检查加载整个 AppKit 窗口依赖。
python3 - "$sourceRoot/MarkdownTool.swift" "$buildRoot/MarkdownRenderer.swift" <<'PY'
from pathlib import Path
import sys
source = Path(sys.argv[1]).read_text()
marker = "\nenum MarkdownRenderer {"
assert source.count(marker) == 1, "MarkdownRenderer 定义已变化，请更新模型测试入口"
Path(sys.argv[2]).write_text("import AppKit\n" + source[source.index(marker):])
PY

cp "$macosRoot/Resources/id-regions.json" "$buildRoot/id-regions.json"
print "检查计算器、身份证与 Markdown 模型"
xcrun swiftc -O "$testRoot/FeatureChecks.swift" "$sourceRoot/ExpressionParser.swift" "$sourceRoot/IDGenerator.swift" "$buildRoot/MarkdownRenderer.swift" "$testRoot/Support/ThemeStub.swift" -o "$buildRoot/FeatureChecks" -framework AppKit
"$buildRoot/FeatureChecks"
print "检查 JSON 折叠模型"
xcrun swiftc -O "$testRoot/JSONFoldingChecks.swift" "$sourceRoot/JSONFolding.swift" -o "$buildRoot/JSONFoldingChecks"
"$buildRoot/JSONFoldingChecks"
print "检查后台开发工具模型"
xcrun swiftc -O "$testRoot/BackendChecks.swift" "$sourceRoot/BackendModels.swift" "$sourceRoot/BackendLogsSQL.swift" "$sourceRoot/TimeResults.swift" -o "$buildRoot/BackendChecks"
"$buildRoot/BackendChecks"
print "检查文件搜索定语与临时文件索引"
xcrun swiftc -O "$testRoot/FileSearchQualifierChecks.swift" "$sourceRoot/FileSearch.swift" "$testRoot/Support/FileSearchPreview.swift" -o "$buildRoot/FileSearchQualifierChecks"
"$buildRoot/FileSearchQualifierChecks"
print "检查文件剪贴板与历史回写"
xcrun swiftc -O "$testRoot/ClipboardFileChecks.swift" "$sourceRoot/Clipboard.swift" -o "$buildRoot/ClipboardFileChecks" -framework AppKit -framework Vision
"$buildRoot/ClipboardFileChecks"
print "macOS 模型与剪贴板检查全部通过"
