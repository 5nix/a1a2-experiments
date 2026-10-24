#!/bin/bash
cd -- "$(dirname -- "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/Library/Android/sdk/platform-tools:$HOME/.volta/bin:$PATH"
if ! command -v node >/dev/null 2>&1 && [ -s "$HOME/.nvm/nvm.sh" ]; then
  . "$HOME/.nvm/nvm.sh"
fi
if ! command -v node >/dev/null 2>&1; then
  echo "请先安装 Node.js 24 或更高版本。"
  read -r -p "按回车关闭……"
  exit 1
fi
node scripts/start-a1.mjs "$@"
result=$?
if [ "$result" -ne 0 ]; then
  read -r -p "启动失败，按回车关闭……"
fi
exit "$result"
