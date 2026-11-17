from pathlib import Path
import argparse
import struct

parser = argparse.ArgumentParser(description="从 PNG 图标集生成 macOS ICNS")
parser.add_argument("iconset", type=Path, help="图标集目录")
parser.add_argument("destination", type=Path, help="生成的 ICNS 路径")
args = parser.parse_args()
images = [
    (b"icp4", "icon_16x16.png"),
    (b"icp5", "icon_32x32.png"),
    (b"icp6", "icon_32x32@2x.png"),
    (b"ic07", "icon_128x128.png"),
    (b"ic08", "icon_256x256.png"),
    (b"ic09", "icon_512x512.png"),
    (b"ic10", "icon_512x512@2x.png"),
    (b"ic11", "icon_16x16@2x.png"),
    (b"ic12", "icon_32x32@2x.png"),
    (b"ic13", "icon_128x128@2x.png"),
    (b"ic14", "icon_256x256@2x.png"),
]
parts = []
for code, name in images:
    png = (args.iconset / name).read_bytes()
    parts.append(code + struct.pack(">I", len(png) + 8) + png)
data = b"".join(parts)
args.destination.write_bytes(b"icns" + struct.pack(">I", len(data) + 8) + data)
