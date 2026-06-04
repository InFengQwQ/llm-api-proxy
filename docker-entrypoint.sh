#!/bin/sh
set -e

# 命名卷首次挂载时为 root 属主，node 用户无法写入
# 每次启动 chown 一次（操作幂等，开销可忽略）
mkdir -p /app/logs
chown -R node:node /app/logs

# 降权为 node 用户执行 CMD
exec su-exec node "$@"
