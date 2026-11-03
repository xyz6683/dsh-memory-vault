#!/usr/bin/env bash
# dsh-memory-vault 发布脚本：按「双远端推送 SOP」配置并推送。
#
# SOP 要点（来自用户记忆库）：
#   1. 远端命名惯例：github 与 gitee 两个 remote；
#   2. GitHub 22 端口常被墙：github 远端一律走官方 443 端口
#      （ssh://git@ssh.github.com:443/<用户>/<仓库>.git）；
#   3. 若 known_hosts 不可写导致 host key 验证失败：在仓库内配置
#      core.sshCommand 指向可写的 UserKnownHostsFile；
#   4. 推送：git push github main && git push gitee main（按分支实际）；
#   5. 验证：git ls-remote 两端分支 == git rev-parse HEAD。
#
# 用法（在插件仓库根目录、任意终端执行）：
#   ./scripts/publish.sh
set -euo pipefail

cd "$(dirname "$0")/.."

GITHUB_URL="ssh://git@ssh.github.com:443/xyz6683/dsh-memory-vault.git"

echo "== 1/5 检查工作区状态"
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "!! 工作区有未提交改动，请先提交或还原。"
  exit 1
fi

echo "== 2/5 配置 github 远端（443 端口）"
if git remote get-url github >/dev/null 2>&1; then
  CURRENT="$(git remote get-url github)"
  if [ "$CURRENT" != "$GITHUB_URL" ]; then
    git remote set-url github "$GITHUB_URL"
    echo "   github 远端已更新: $GITHUB_URL"
  else
    echo "   github 远端已就绪: $CURRENT"
  fi
else
  git remote add github "$GITHUB_URL"
  echo "   github 远端已添加: $GITHUB_URL"
fi

echo "== 3/5 确保 host key 可验证（沙盒/不可写 known_hosts 环境）"
if ! git config core.sshCommand >/dev/null 2>&1; then
  git config core.sshCommand "ssh -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/tmp/git-known-hosts"
  echo "   core.sshCommand 已配置（known_hosts 走 /tmp）"
fi

echo "== 4/5 推送 main 分支与 tag"
git push github main
git push github v0.1.0 || true   # 已有同名 tag 时跳过

echo "== 5/5 验证同步"
REMOTE_HEAD="$(git ls-remote github main | cut -f1)"
LOCAL_HEAD="$(git rev-parse HEAD)"
if [ "$REMOTE_HEAD" = "$LOCAL_HEAD" ]; then
  echo "   ✅ github/main == 本地 HEAD"
else
  echo "   !! 不一致：远端 $REMOTE_HEAD 本地 $LOCAL_HEAD"
  exit 1
fi

echo
echo "✅ GitHub 推送完成。剩余两步（Web 界面操作）："
echo "  1. 仓库 About → Topics 添加 dsh-plugin（dshplugin.store 自动收录）"
echo "  2. https://dshplugins.com/submit 提交人工审核"
echo
echo "可选：配置 Gitee 镜像远端（双推备份）："
echo "  git remote add gitee git@gitee.com:<你的gitee用户名>/dsh-memory-vault.git"
echo "  git push gitee main && git push gitee v0.1.0"
