# RepoPilot Prototype — 可丢弃工程 Spike

> 状态：`DISPOSABLE_SPIKE / NOT_AN_IMPLEMENTATION_BASELINE`
> 建立日期：2026-08-06
> 定位：为 Stage 0 的 F-01（用户证据）、F-03（Benchmark fixture）、F-04（机器 schema）提供**可运行的证据来源**

## 这是什么，不是什么

**是**：一个能真正跑通「Vite + React + TS 构建失败 → 修复 → 验证 → 补丁审查」闭环的 Electron 桌面应用。

**不是**：
- 不是 Stage 0 Gate 通过的证明。ADR 001–017 仍全部是 `Proposed / Open`，没有一份 Accepted。
- 不是 `local-desktop-only-topology.md` 里 `utilityProcess` / SQLite / 发行方案已被接受的证据。
- 不是 M2 Walking Skeleton。M2 需要在 Gate 通过并获得独立授权后，按 `docs/development/m2-link1-execution-contract.md` 从 `M2-WP0` 开始。
- 这里的代码**不应**被当作 M2 的工程起点直接继承。它的价值是回答"这些设计假设成立吗"，不是"这就是产品"。

## 已经证明的（有机器证据）

`pnpm test` — 44 个测试，其中 1 个是跑真实 `tsc + vite build` 的端到端链路。

| 断言 | 证据位置 |
|---|---|
| tracked-only 快照不含 `.git`，untracked 文件永不进快照 | `mutation.test.ts` / `repo.test.ts` |
| dirty worktree 默认阻断且标记 `overridable`，越过后如实记为 `DIRTY_WORKTREE` | `repo.test.ts` |
| monorepo 子包导入：路径以子包为坐标系，profile 独立解析 | `repo.test.ts` |
| dirty 判定只看导入范围，别的子包脏了不误伤 | `repo.test.ts` |
| exact-span replace 命中 0 次 → `ZERO_MATCH`，工作区逐字节不变 | `mutation.test.ts` |
| 命中多次 → `MULTIPLE_MATCH`，绝不"改第一个" | `mutation.test.ts` |
| 切代后旧 receipt 失效 | `mutation.test.ts` |
| `CREATE_FILE` 撞到已存在文件 → `TARGET_EXISTS`，无隐式覆盖 | `mutation.test.ts` |
| 绝对路径 / `..` / 受保护路径 / 越界路径全部 fail-closed | `mutation.test.ts` |
| 批次中任一 operation 失败 → 整批零写入 | `mutation.test.ts` |
| 基线验证真的失败在 `TS2345`，不是 spawn 失败伪装 | `agent.e2e.test.ts` |
| 修复后 `build` 真的 `EXIT_ZERO` | `agent.e2e.test.ts` |
| 规划阶段没有产生任何 R1 副作用 | `agent.e2e.test.ts` |
| 补丁 diff 里不含宿主绝对路径 | `agent.e2e.test.ts` |
| `dist/` 等生成文件不进补丁，但被显式列出而非静默丢弃 | `agent.e2e.test.ts` |
| **修复过程中宿主仓库全程 `git status` 干净** | `agent.e2e.test.ts` |
| 补丁应用：干净场景真的改对宿主文件，且不 commit 不 stage | `apply.test.ts` |
| 补丁应用：目标文件已漂移 → `--check` 拒绝，宿主逐字节不变 | `apply.test.ts` |
| 补丁应用：子包场景用 `--directory` 还原坐标系 | `apply.test.ts` |

## 尚未证明的

- 模型判断力：端到端测试用的是确定性替身，不是真实模型。真实闭环需要你自己配 API key 跑。
- 隔离强度：`utilityProcess` + 子进程**不是**容器级沙箱。`node_modules` 目前是宿主的 symlink，构建脚本以你的用户权限运行。这是原型的显式残余风险，写在 `workspace.ts:linkDependencies` 的注释里。
- 持久化：Run 事件是 JSONL，不是 SQLite WAL；没有加密、没有保留期、没有级联清理。
- 崩溃恢复：事件日志能重放，但 Core 重启后不会自动恢复进行中的 Run。
- 一切 P1：Skill、CrossReview、多表面、Continuation、资源/热治理都没做。

## 界面

```
┌──────────────┬─────────────────────────────┬──────────────┐
│ 项目 A        │  项目卡片 / 新建任务          │  文件树       │
│  ├ 运行 1     │  —— 或 ——                   │  · 改动标绿   │
│  └ 运行 2     │  对话流 + 终端输出            │  · 点开看内容 │
│ 项目 B        │                             │  · 可开关     │
│  └ 运行 3     │                             │              │
│ + 授权仓库    │                             │              │
├──────────────┤                             │              │
│ ⚙ 设置 🗂 文件 │                             │              │
└──────────────┴─────────────────────────────┴──────────────┘
```

- **侧栏**：项目 → 该项目下的多轮运行。点运行会自动切回它所属的项目。
- **对话流**：事件日志与工具调用合并成一条时间序。`run_command` 渲染成终端块，
  mutation 渲染成 diff，其余工具默认折叠。右上角可切回「原始事件」视图。
- **文件树**：选中运行时看的是**该运行工作区的当前 generation**，也就是 Agent 改过之后的样子，
  改动过的文件标绿；没选运行时看导入快照的原貌。Agent 每次提交 mutation 会自动刷新。
- **设置**：环境自检 + 模型连接（BYOK 状态、测试连接）。没有可用连接时按钮上有 ⚠。

文件浏览是只读的，路径在受管根内解析，`..`、绝对路径、symlink 一律拒绝
（自检里有对应的负向断言）。

## 架构

```
Renderer (React, sandbox, 无 Node)
   ↓ typed preload（白名单方法，无通用 invoke）
Electron Main（能力代理：窗口 / 原生目录选择 / Core 监督）
   ↓ 私有 utilityProcess IPC（不监听任何端口）
Desktop Agent Core ← 唯一业务权威
   ├── Agent Loop（规划强制只读 → 审批 → 执行 → 有界自修复）
   ├── Tool Gateway（R0–R4 风险分级、zod schema 双重校验、唯一 resolution）
   ├── Mutation 引擎（read receipt + digest 前置条件 + generation CAS）
   ├── Model Gateway（固定 origin、冻结路由、egress manifest、禁止自动 fallback）
   └── 验证器（结构化 argv、进程组终止、exit-code 判别联合）
        ↓
   MaterializedWorkspace（宿主仓库只读，改动只发生在 gen-N 副本）
```

关键边界：**Main 不持有 Run/Approval/Patch 权威，Renderer 连 channel 名字都拿不到。**

## 运行

```bash
cd prototype && pnpm install && pnpm rebuild electron
```

```bash
pnpm dev
```

然后在「⚙ 设置 · API」里填 API Key —— **填完即生效，不用重启**。也可以走环境变量：

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

### 模型配置（参考 `temp/neovate-code` 的 provider 设计）

内置 12 个 provider：Anthropic / OpenAI / DeepSeek / Moonshot / 智谱 / 阿里百炼 /
火山方舟 / 硅基流动 / 魔搭 / OpenRouter / AIHubMix / xAI。不够就自己加。

搬过来的设计：

| 设计 | 出处 | 我们的实现 |
|---|---|---|
| provider 描述符自带模型清单 | `providers/types.ts` 的 `Provider` | `core/model/registry.ts`，UI 给下拉框而不是逼你手打 model id |
| 按 `apiFormat` 选适配器 | `utils.ts:144-188` | 适配器按 `wire`（anthropic / openai）划分，一个 openai 适配器服务所有兼容端点 |
| 缺省走 OpenAI 协议 | `model.ts:274-310` `normalizeProviders` | `normalizeBuiltIn/normalizeCustom` 里 `wire ?? 'openai'` |
| 内置 + 自定义合并，自定义覆盖 | `model.ts:78-89` `mergeProviders` | `allProviders()`，同 id 时自定义胜出 |
| key 优先级 config > env | `utils.ts:50-65` `getProviderApiKey` | `resolveKeySource()` |
| base URL 可覆盖 | `utils.ts:36-48` `getProviderBaseURL` | `resolveOrigin()` |
| 应用内录入，无需重启 | `slash-commands/builtin/login.tsx` | 设置页直接填 |

base URL 存的是**完整地址含版本路径** —— 智谱是 `/api/paas/v4`、火山是 `/api/v3`，
硬拼 `/v1` 会错。只填域名时自动补 `/v1`，带路径的原样保留。

**唯一没照抄的**：那份 CLI 把 API key 明文写进全局 JSON 配置
（`login.tsx:342-351` → `config.set('provider.<id>.options.apiKey')`），工程审计里这条被 Reject。
这里改成 Electron `safeStorage` 加密（密钥由 macOS 钥匙串托管），界面只显示末四位，
完整值不回传 Renderer、不写日志、不进事件；Core 只在内存持有，重启即丢、由 Main 重新注入。

覆盖 origin 之后 profile 会被标成 **`isRelay`**，UI 上有明确警示 ——
数据流向变了这件事必须说出来，而不是静默接受。已冻结的 Attempt 用的是**冻结当时**的 origin，
运行中改设置不会改变在飞的请求。

然后：授权仓库 → 快照导入 → 填 TaskSpec 选验证命令 → 创建 → 审批计划 → 看时间线 → 审查 diff → 接受或拒绝。

`fixtures/vite-react-broken` 是一个自带真实构建错误的单包仓库，可以直接拿它当第一个任务目标。

### 导入不设门禁

选中目录就是信任手势。任何项目都能导进来并操作：

| 情况 | 处理 |
|---|---|
| dirty worktree | 直接导入，标记 `DIRTY_WORKTREE` + 改动数 |
| 非 git 目录 | 直接导入，标记 `NO_VCS` |
| 不是 Vite / React / TS | 直接导入，`supportStatus` 只是信息 |
| monorepo | 直接导入整仓；也可以一键切到某个子包 |
| 检测不出命令 | 直接导入；创建任务时自己填一条验证命令 |
| 一个验证命令都不选 | 照样跑，进入**未验证模式** |

只在物理上做不到时才失败：目录读不了（`PATH_UNREADABLE`）、没有可用文件（`EMPTY_TREE`）、超出容量（`CAPACITY_EXCEEDED`）。

### 补丁交付

接受补丁之后有三个出口：

| 方式 | 行为 |
|---|---|
| 复制到剪贴板 | 带元信息头（base、baseKind、是否验证、未验证项、apply/revert 命令）的完整 patch 文本 |
| 保存为 `.patch` | 同上，写到你选的位置 |
| 应用到仓库 | 真的写宿主文件。二次确认 → `git apply --check` 干跑 → 通过才写 |

应用是原型里**唯一**会写你仓库的路径，所以刻意做得很窄：交给 `git apply`，
不用 `--3way`、不用 `--reject`、不自动 commit、不自动 stage。
任何冲突整笔拒绝，此时一个字节都没写 —— `apply.test.ts` 对这一点有断言。

### 唯一没有让步的地方：成功的定义

门禁全部放开之后，`SUCCEEDED` 靠这条区分保住意义：

| 终态 | 条件 |
|---|---|
| `SUCCEEDED` | 有**通过的**验证 **且** 用户接受了补丁 |
| `ACCEPTED_UNVERIFIED` | 用户接受了补丁，但没有机器验证支撑 |

两者都由 Core 在状态转换处强制（`authority.ts:setStatus`），构造不出违反的对象。
影响"成功意味着什么"的事实 —— `baseKind`、`dirtyFileCount`、`subPath`、
`verificationCommands`、`userDefinedCommands` —— 全部写进 `RUN_CREATED` 事件和 `NOTE`。

未验证模式下 Agent 照常规划、审批、改文件、出补丁，只是跳过基线/重验/自修复，
系统 prompt 也会明确告诉模型「你无法证明改动是对的，请保守行事并说明没把握的地方」。

跑测试：

```bash
pnpm test
```

## 与文档的对应关系

代码里对不变式的强制点都标了对应的 PRD 条款，主要几处：

- `shared/domain.ts` — `RunTerminalFacts` 让 `SUCCEEDED` 在**类型层**无法脱离 verification + patch acceptance 构造（PRD-DIFF-002）
- `core/mutation.ts` — 全量模拟再落盘，失败零写入（PRD-MUT-001..004）
- `core/model/gateway.ts` — purpose + 冻结路由 + egress manifest + `automaticFallback=DENY`（PRD-MODEL-001..005）
- `core/command.ts` — 判别联合式命令结果，非零退出不可能被当成成功（PRD-RUN-002）
- `main/index.ts` — 方法白名单 + sender 绑定 + 协议版本校验（overlay §3）

`temp/neovate-code` 审计里被 Reject 的做法，这里逐条做了相反的选择：无 fuzzy apply、无绝对路径直写、无隐式覆盖、无宿主 login shell、无自动审批、无明文 header/body 日志。
