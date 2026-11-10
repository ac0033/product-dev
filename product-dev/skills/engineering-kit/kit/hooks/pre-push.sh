#!/bin/sh
# engineering-kit:pre-push（由工程闸门套件管理；重新同步会更新本文件）
# 业务含义：终端里直接 git push 也要过推送闸门，不依赖 agent 的钩子。失败则拒绝推送。
root="$(git rev-parse --show-toplevel)"
node "$root/scripts/engineering/gate/verify.mjs" || exit 1
