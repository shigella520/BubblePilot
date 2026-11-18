#!/bin/sh
set -eu
cd "$(dirname "$0")"
mkdir -p .assets
curl -fsSL --max-time 90 https://github.com/linebender/resvg/releases/download/v0.45.1/resvg-linux-x86_64.tar.gz -o .assets/resvg.tar.gz
curl -fsSL --max-time 90 https://raw.githubusercontent.com/notofonts/noto-cjk/Serif2.003/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf -o .assets/NotoSansCJKsc-Regular.otf
# Dockerfile verifies both downloaded files against pinned SHA-256 values.
docker build --platform linux/amd64 -t bp-svg-feasibility:local .
