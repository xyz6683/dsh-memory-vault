#!/usr/bin/env bash
# dsh-memory-vault 一键发布脚本：配置 remote 并推送 main 分支与 v0.1.0 tag。
# 用法（在插件仓库根目录、你自己的终端里执行）：
#   ./scripts/publish.sh git@github.com:<你的用户名>/dsh-memory-vault.git
#   或
#   ./scripts/publish.sh https://github.com/<你的用户名>/dsh-memory-vault.git
set -euo pipefail

REMOTE_URL="${1:?用法: $0 <仓库地址，如 git@github.com:USER/dsh-memory-vault.git>}"

cd "$(dirname "$0")/.."

echo "== 1/4 检查工作区状态"
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "!! 工作区有未提交改动，请先提交或还原。"
  exit 1
fi

echo "== 2/4 配置 remote"
if git remote get-url origin >/dev/null 2>&1; then
  CURRENT="$(git remote get-url origin)"
  if [ "$CURRENT" != "$REMOTE_URL" ]; then
    git remote set-url origin "$REMOTE_URL"
    echo "   remote origin 已更新: $REMOTE_URL"
  else
    echo "   remote origin 已存在: $CURRENT"
  fi
else
  git remote add origin "$REMOTE_URL"
  echo "   remote origin 已添加: $REMOTE_URL"
fi

echo "== 3/4 推送 main 分支"
git push -u origin main

echo "== 4/4 推送 tag"
git push origin v0.1.0

echo
echo "✅ 推送完成。剩余两步（Web 界面操作）："
echo "  1. 仓库 About → Topics 添加 dsh-plugin（dshplugin.store 自动收录）"
echo "  2. https://dshplugins.com/submit 提交人工审核"
