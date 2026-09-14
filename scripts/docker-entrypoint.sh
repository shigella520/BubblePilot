#!/bin/sh
set -eu

node dist/app/migrate.js
node dist/app/prepare-memory.js
exec node dist/app/main.js
