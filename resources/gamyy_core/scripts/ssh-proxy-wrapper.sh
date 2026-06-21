#!/bin/bash
# SSH ProxyCommand 包装脚本
# 由 SSH 以非交互模式调用，此时 alias node='winpty node.exe' 不会加载，
# PATH 里的 node/node.exe 是真实可执行文件，不是 alias。
exec node "$(dirname "$0")/ssh-via-socks.js" "$@"
