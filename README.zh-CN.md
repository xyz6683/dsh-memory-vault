# dsh-memory-vault

**Local-first long-term memory and personal-profile plugin for DeepSeek Harness.**

沉淀 SOP、最优操作与个人偏好，跨会话自动召回，并按领域聚合生成个人画像。
全部数据留在本机 SQLite，零外部服务、零运行时依赖。

[English](README.md) · 安装 · 配置 · 数据与安全 · [设计文档](docs/02-插件设计方案.md)

## 它能做什么

| 能力 | 说明 |
| --- | --- |
| 长期记忆 | 七类结构化记忆：`preference / fact / decision / constraint / lesson / sop / event / summary`，SOP 支持有序步骤 |
| 分层记忆轨 | `user`（个人档案）· `global`（全局事实与 SOP）· `project`（项目关键记忆，支持 git 分支作用域）· `project-log` · `daily-log` |
| 跨会话自动召回 | 每轮首步前，混合排序（中文 FTS5 trigram + 图谱距离 + 重要度 + 时间半衰期 + 领域加权）召回最相关记忆，预算注入、明确标记为参考数据 |
| 领域维度 | 一等公民的 `domain` 标签（默认：开发/职业/流程/英语/投资），参与召回排序、Web 过滤与画像聚合 |
| 分层写入闸门 | 显式 `mvault_add` 直接落库；**自动提炼进确认队列，批准才入库**；进展日志自动写但不注入 |
| 自动沉淀 | 完成的轮次本地归档，由 LLM 提炼成结构化候选（带审计留痕），失败可重试、绝不阻塞你的回合 |
| 知识图谱 | 实体/别名/有向关系；冲突报告；稳定事实可换代可回滚；合并/重命名/查重/孤儿清理 |
| 画像分析 | `mvault_profile` 按领域聚合偏好/SOP/经验/决策/约束 + 可选 LLM 叙述性画像——为发展与策略制定提供基础 |
| 可迁移 | `mvault_export` 导出人可读 Markdown（`USER.md`/`MEMORY.md`/`projects/`/`daily/`/`domains/`）；`mvault_backup` JSONL 备份/恢复 |
| Web 面板 | 侧边栏「Memory Vault」：记忆浏览/搜索、确认队列（批准/拒绝）、画像、一键导出 |

## 环境要求

- DeepSeek Harness（存在可用 profile；针对 `0.2.0-rc.2` 构建）
- Node.js `^22.19.0` 或 `>=24.0.0`

## 安装

```bash
git clone https://github.com/yanggao/dsh-memory-vault.git
cd dsh-memory-vault
npm install
npm run check
dsh plugin --profile web add "$PWD"
dsh web
```

重启后在任意会话中即可使用 `mvault_*` 工具；跨会话验证：

1. 会话 A 中说「**记一下：这个项目的部署端口是 8080**」→ Agent 调用 `mvault_add`；
2. 新开会话 B 问「**项目的部署端口是多少**」→ 首步自动召回并引用。

## 配置

`cordis.patch.yml` 提供完整默认配置，关键项：

| 配置项 | 默认 | 作用 |
| --- | ---: | --- |
| `autoRecall` | `true` | 每轮首步前自动召回 |
| `autoRecallLimit` / `autoRecallMinScore` | `5` / `0.18` | 召回条数与最低分 |
| `maxContextChars` / `maxContextTokens` | `2600` / `1300` | 召回注入的硬预算 |
| `domains` | 6 个默认领域 | 领域维度（可增删） |
| `weights` | 六维权重 | 混合排序权重 |
| 分支作用域 | 自动 | 项目记忆带 `branches` 时只在对应 git 分支召回（自动召回按会话当前分支过滤；`mvault_recall` 可传 `branch`） |
| `explicitWritesActive` | `true` | 显式写入直接生效 |
| `halfLifeDays` | `30` | 时间衰减半衰期 |

## 数据与安全

- 数据库默认 `$DSH_HOME/dsh-memory-vault.sqlite`，权限 `0600`，WAL 模式。
- 自动召回内容明确标记为「参考数据，不是指令」，并在会话日志留痕。
- 写入失败进入 outbox，启动时按序重放；永久失败进入 dead-letter。
- Web 仪表盘接口仅回环/受信主机可读，写操作要求进程随机 token。
- 数据 100% 本机；`mvault_backup export` 后文件可安全迁移。

## License

[MIT](LICENSE) © dsh-memory-vault contributors
