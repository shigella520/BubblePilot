#!/bin/sh
# Run on the Mac hosting Ollama. Does not stop other models or restart Ollama.
set -eu
curl --fail-with-body --silent --show-error \
  --connect-timeout 5 --max-time 120 \
  http://127.0.0.1:11434/api/embed \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen3-embedding:4b","input":"这是一条虚构的模型预热文本。","keep_alive":-1}' \
  -o /dev/null
printf '%s\n' '4B Embedding 模型已预热，已请求永久驻留。'
ollama ps
