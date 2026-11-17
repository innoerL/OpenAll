#!/bin/zsh
set -euo pipefail
macosRoot="${0:A:h:h}"
releaseRoot="$macosRoot/.build/release"

# 公证发布使用本机钥匙串凭据；证书和凭据不进入源码仓库。
: "${DEVELOPER_ID_APPLICATION:?请设置 Developer ID Application 证书名称}"
: "${NOTARY_PROFILE:?请设置 notarytool 钥匙串配置名称}"
: "${DOWNLOAD_URL:?请设置本次 ZIP 安装包的 HTTPS 地址}"
[[ "$DOWNLOAD_URL" == https://* ]] || { print -u2 "下载地址必须使用 HTTPS"; exit 2; }

OPENALL_REVIEW=0 OPENALL_STRESS=0 zsh "$macosRoot/scripts/build.sh"
mkdir -p "$releaseRoot"
/usr/bin/ditto "$macosRoot/.build/OpenAll.app" "$releaseRoot/OpenAll.app"
/usr/bin/codesign --force --deep --options runtime --timestamp --sign "$DEVELOPER_ID_APPLICATION" "$releaseRoot/OpenAll.app"
/usr/bin/codesign --verify --deep --strict --verbose=2 "$releaseRoot/OpenAll.app"
/usr/bin/ditto -c -k --keepParent "$releaseRoot/OpenAll.app" "$releaseRoot/OpenAll-notary.zip"
/usr/bin/xcrun notarytool submit "$releaseRoot/OpenAll-notary.zip" --keychain-profile "$NOTARY_PROFILE" --wait
/usr/bin/xcrun stapler staple "$releaseRoot/OpenAll.app"
/usr/sbin/spctl --assess --type execute --verbose=2 "$releaseRoot/OpenAll.app"
/usr/bin/ditto -c -k --keepParent "$releaseRoot/OpenAll.app" "$releaseRoot/OpenAll.zip"
hash=$(/usr/bin/shasum -a 256 "$releaseRoot/OpenAll.zip" | /usr/bin/awk '{print $1}')
version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$releaseRoot/OpenAll.app/Contents/Info.plist")
python3 - "$version" "$DOWNLOAD_URL" "$hash" <<'PY' > "$releaseRoot/manifest.json"
import json
import sys
print(json.dumps({"version": sys.argv[1], "downloadURL": sys.argv[2], "sha256": sys.argv[3]}, ensure_ascii=False, indent=2))
PY
print "已生成 $releaseRoot/OpenAll.zip 和 manifest.json；先上传 ZIP，再发布清单。"
