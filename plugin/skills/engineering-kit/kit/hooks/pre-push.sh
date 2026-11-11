#!/bin/sh
# engineering-kit:pre-push（由工程闸门套件管理；重新同步会更新本文件）
# 业务含义：终端里直接 git push 也要过推送闸门，不依赖 agent 的钩子。失败则拒绝推送。
# 判定逻辑都在 verify.mjs 里（可测）：这里只把 git 传来的参数（远端名、地址）和 stdin（要推送的引用）原样交给它，
# 由它核对实际推送的提交是不是闸门核对过的当前 HEAD。
root="$(git rev-parse --show-toplevel)"
node "$root/scripts/engineering/gate/verify.mjs" --pre-push "$@" || exit 1
