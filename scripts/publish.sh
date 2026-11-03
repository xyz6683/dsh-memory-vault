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
GITEE_URL="git@gitee.com:xyz6683/dsh-memory-vault.git"

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

echo "== 4/6 配置 gitee 远端（双推备份，按 SOP 走 22 端口）"
if git remote get-url gitee >/dev/null 2>&1; then
  CURRENT="$(git remote get-url gitee)"
  if [ "$CURRENT" != "$GITEE_URL" ]; then
    git remote set-url gitee "$GITEE_URL"
    echo "   gitee 远端已更新: $GITEE_URL"
  else
    echo "   gitee 远端已就绪: $CURRENT"
  fi
else
  git remote add gitee "$GITEE_URL"
  echo "   gitee 远端已添加: $GITEE_URL"
fi

echo "== 5/6 双推 main 分支与 tag"
git push github main
git push gitee main
git push github v0.1.0 || true   # 已有同名 tag 时跳过
git push gitee v0.1.0 || true

echo "== 6/6 验证双端同步（SOP 第 5 步）"
LOCAL_HEAD="$(git rev-parse HEAD)"
for remote in github gitee; do
  REMOTE_HEAD="$(git ls-remote "$remote" main | cut -f1)"
  if [ "$REMOTE_HEAD" = "$LOCAL_HEAD" ]; then
    echo "   ✅ $remote/main == 本地 HEAD"
  else
    echo "   !! 不一致：$remote $REMOTE_HEAD 本地 $LOCAL_HEAD"
    exit 1
  fi
done

echo
echo "✅ GitHub + Gitee 双推完成。剩余两步（Web 界面操作）："
echo "  1. GitHub 仓库 About → Topics 添加 dsh-plugin（dshplugin.store 自动收录）"
echo "  2. https://dshplugins.com/submit 提交人工审核"
