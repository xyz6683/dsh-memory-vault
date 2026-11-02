# M1 GUI 实测清单

> 目标：验证「会话 A 沉淀 → 会话 B 跨会话自动召回」的核心闭环。
> 前置：插件已通过 `dsh plugin --profile web add` 安装（`--dump-config` 可见 `memory-vault` 行）。

## 步骤 0：重启 dsh web（插件加载需要）

```bash
# 1. 在运行 dsh web 的终端 Ctrl+C
# 2. 重新启动
dsh web
# 3. 浏览器刷新 http://127.0.0.1:3080
```

## 步骤 1：验证插件已加载（会话 A）

新建会话，问：

> 你有哪些记忆工具？列一下 vault 开头的工具名。

预期：Agent 列出 `vault_add / vault_recall / vault_expand / vault_forget / vault_revert / vault_graph / vault_profile / vault_review / vault_export / vault_backup / vault_archive_* / vault_entity_*` 等工具。

## 步骤 2：会话 A 沉淀记忆

> 记一下：这个项目的部署端口是 8080，用 docker compose 启动。领域是开发。

预期：Agent 调用 `vault_add`，回复类似 `Stored memory <uuid> …`。

再沉淀一条带 SOP 的：

> 记住我的发版 SOP：跑测试 → 打 tag → 推送远端。这是流程领域。

预期：`kind=sop` + 3 个 steps 落库。

## 步骤 3：会话 B 验证跨会话召回

**新建会话**（不引用会话 A 的任何内容），问：

> 这个项目的部署端口是多少？

预期：回复**开头**出现 `<memory_vault_context>` 召回块（可折叠），内容含 8080，Agent 据此回答。

再问：

> 发版流程是什么？

预期：召回 SOP 记忆，回答按 1/2/3 步骤列出。

## 步骤 4：验证导出与备份

> 把记忆导出成 Markdown 文件。

预期：`vault_export` 返回文件清单；`~/.dsh/dsh-memory-vault-export/` 下可见 `MEMORY.md`、`domains/dev.md`、`domains/workflow.md` 等，可直接打开查看。

## 步骤 5：验证确认队列工具面（此时应为空）

> 查看待确认的记忆建议。

预期：`vault_review {action: list}` 返回空列表（需开启 `autoExtract: true` 后才有自动提炼候选）。

## 步骤 6：验证 Web 面板与画像

1. 左下角侧边栏点「Memory Vault」→ 面板打开：
   - 「记忆」Tab：能看到刚才沉淀的两条记忆，可搜索/过滤/删除；
   - 「待确认」Tab：空（autoExtract 默认关）；
   - 「画像」Tab：各领域计数 + 偏好/SOP 清单；
   - 「导出」Tab：点导出，`~/.dsh/dsh-memory-vault-export/` 出现 Markdown 文件。
2. 对 AI 说「**分析我的画像**」→ 预期调用 `vault_profile`，返回结构化聚合（含偏好与 SOP 清单）。

## 回归注意

- 若工具名未出现：确认 `dsh --profile web --dump-config | grep memory-vault` 有输出，且重启了 dsh web（仅刷新浏览器不够）。
- 若召回块没出现但工具可用：检查 `~/.dsh/profiles/web/cordis.patch.yml` 中 `memory-vault` 行 `config.autoRecall` 是否为 true。
- 数据文件：`~/.dsh/dsh-memory-vault.sqlite`（0600），卸载插件不会删除数据。

## 验收标准

- [ ] 会话 A 两条记忆落库
- [ ] 会话 B 两个问题均自动召回并正确回答
- [ ] 导出文件存在且可读
- [ ] `vault_review list` 正常返回空
