#!/bin/zsh
set -euo pipefail
macosRoot="${0:A:h:h}"
repositoryRoot="${macosRoot:h}"
appPath="${1:?请提供 OpenAll.app 路径}"
shift
[[ "$appPath" == /*.app && -d "$appPath/Contents" ]] || { print -u2 "目标必须是已创建的 OpenAll.app 绝对路径"; exit 2; }
(( $# > 0 )) || { print -u2 "请提供至少一种架构：arm64 或 x86_64"; exit 2; }
sourcePath="$repositoryRoot/shared/gold-desk/app"
[[ -f "$sourcePath/main.cjs" ]] || { print -u2 "缺少内置金价源码：$sourcePath"; exit 2; }
runtimeVersion=45.4.1
cacheRoot="${OPENALL_ELECTRON_CACHE:-${XDG_CACHE_HOME:-$HOME/Library/Caches}/OpenAll/electron}"
mkdir -p "$cacheRoot" "$macosRoot/.build" "$appPath/Contents/Helpers"
stage=$(mktemp -d "$macosRoot/.build/gold-package.XXXXXX")
trap 'rm -rf "$stage"' EXIT

architectures=()
for requested in "$@"; do
    case "$requested" in
        x86_64|x64) architecture=x64 ;;
        arm64) architecture=arm64 ;;
        *) print -u2 "不支持的金价架构：$requested"; exit 2 ;;
    esac
    architectures+=("$architecture")
    filename="electron-v${runtimeVersion}-darwin-${architecture}.zip"
    archive="$cacheRoot/$filename"
    # 固定官方发行包摘要，缓存和在线下载使用同一校验流程。
    case "$architecture" in
        arm64) expected=d080c3b05a01bd16137f2c12ab9ebf083c577757fe846844ba325bafa8e8bdf4 ;;
        x64) expected=1c80d2ccf71b02c8fd9940fd09cafe88090a48c1bab0193c79b597b08d890e79 ;;
    esac
    if [[ ! -f "$archive" ]]; then
        download="$stage/$filename"
        /usr/bin/curl --fail --location --retry 3 --output "$download" "https://github.com/electron/electron/releases/download/v${runtimeVersion}/$filename"
    else
        download="$archive"
    fi
    actual=$(/usr/bin/shasum -a 256 "$download" | /usr/bin/awk '{print $1}')
    [[ "$actual" == "$expected" ]] || { print -u2 "Electron 校验失败：$filename"; exit 3; }
    if [[ "$download" != "$archive" ]]; then mv "$download" "$archive"; fi

    extraction="$stage/$architecture"
    mkdir -p "$extraction"
    /usr/bin/ditto -x -k "$archive" "$extraction"
    helper="$extraction/Electron.app"
    resources="$helper/Contents/Resources"
    /usr/bin/ditto "$sourcePath" "$resources/app"
    rm -f "$resources/default_app.asar"
    cp "$extraction/LICENSE" "$resources/Electron-LICENSE"
    cp "$extraction/LICENSES.chromium.html" "$resources/LICENSES.chromium.html"
    plist="$helper/Contents/Info.plist"
    /usr/libexec/PlistBuddy -c 'Set :CFBundleName OpenAll金价' "$plist"
    /usr/libexec/PlistBuddy -c 'Set :CFBundleDisplayName OpenAll金价' "$plist"
    /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier local.openall.gold.$architecture" "$plist"
    /usr/libexec/PlistBuddy -c 'Add :LSUIElement bool true' "$plist"
    if [[ -f "$appPath/Contents/Resources/OpenAll.icns" ]]; then
        cp "$appPath/Contents/Resources/OpenAll.icns" "$resources/OpenAll.icns"
        /usr/libexec/PlistBuddy -c 'Set :CFBundleIconFile OpenAll.icns' "$plist"
    fi
    /usr/bin/codesign --force --deep --sign - "$helper"
    /usr/bin/codesign --verify --deep --strict "$helper"
    destination="$appPath/Contents/Helpers/OpenAllGold-$architecture.app"
    rm -rf "$destination"
    mv "$helper" "$destination"
done

# 开发构建切回单架构时移除上一次生成的另一个组件。
for architecture in arm64 x64; do
    if (( ! ${architectures[(Ie)$architecture]} )); then
        rm -rf "$appPath/Contents/Helpers/OpenAllGold-$architecture.app"
    fi
done
print "已打包内置金价组件：${architectures[*]}（Electron $runtimeVersion）"
