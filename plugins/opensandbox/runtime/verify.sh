#!/bin/sh
set -eu
image=${1:-bubblepilot-sandbox-python:test}
root=$(CDPATH='' cd -- "$(dirname -- "$0")/../../.." && pwd)
docker run --rm --platform linux/amd64 --network none --memory 512m --cpus 1 \
  --cap-drop ALL --security-opt no-new-privileges \
  --mount "type=bind,src=$root/plugins/opensandbox/runtime/smoke.py,dst=/tmp/smoke.py,readonly" \
  "$image" python /tmp/smoke.py
# Prove storage survives commands in one container, but is absent in a new one.
id=$(docker run -d --platform linux/amd64 --network none --memory 512m --cap-drop ALL --security-opt no-new-privileges "$image" sleep 60)
trap 'docker rm -f "$id" >/dev/null 2>&1 || true' EXIT HUP INT TERM
docker exec "$id" python -c "from pathlib import Path; Path('/workspace/task-only.txt').write_text('fictional')"
docker exec "$id" python -c "from pathlib import Path; assert Path('/workspace/task-only.txt').read_text() == 'fictional'"
docker run --rm --platform linux/amd64 --network none --memory 512m --cap-drop ALL --security-opt no-new-privileges "$image" python -c "from pathlib import Path; assert not Path('/workspace/task-only.txt').exists()"
