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

`pnpm test` — 564 个测试，其中 1 个是跑真实 `tsc + vite build` 的端到端链路。

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
| 账本：provider 未回报用量（null）计入"未知轮次"，绝不折算成 0 | `domain.test.ts` |
| 账本：不涉及 token 的记账（工具调用）不污染未知计数 | `domain.test.ts` |
| failureClass / unknownUsageTurns 增量字段跨重启往返，旧快照缺字段读出 undefined 而非补 0 | `persistence.test.ts` |
| **权威层 e2e**：注册 → 导入 → 审批 → 修复 → 真验证通过 → 接受 → `SUCCEEDED`，账本逐轮对账（含用量未知轮） | `authority.e2e.test.ts` |
| **权威层 e2e**：自修复用尽 → `FAILED` + `failureClass` + 挽救补丁封存，接受被状态门禁拒绝 | `authority.e2e.test.ts` |
| **权威层 e2e**：交叉审核阻断 → 整改 → 重验 → 重封存（digest 变化）→ 第二轮通过，2 审 1 改如实记账 | `authority.e2e.test.ts` |
| **权威层 e2e**：`COUNTER_EXHAUSTED` 后用户授权续循环 → 续期轮收敛，累计 4 审 2 改 1 续期、轮次连续编号；终态/`REVIEWER_PASSED` 续期被拒 | `authority.e2e.test.ts` |
| 外部 CLI 隔离（**真子进程**）：外部代理看到的 HOME 不是真实 HOME、读不到 `~/.claude`、宿主凭据与 `GITHUB_TOKEN` 不在其环境、cwd 是一次性目录、调用后 HOME 被删 | `external/connector.test.ts` |
| 外部 CLI：无显式凭据拒绝启动（不以宿主登录态运行）、非零退出/不可解析输出一律 FAILED 且不编造发现、manifest 不含 raw secret 与 prompt 正文 | `external/connector.test.ts` |
| 外部 CLI：同厂商审核直接拒绝（`SAME_VENDOR_REVIEW_DENIED`），异构是不变式不是披露项 | `external/connector.test.ts` |
| 动态形态探测：只有桌面应用 → `PRESENT_NOT_AUTOMATABLE` 且指向 API；CLI 与 .app 并存时优先 CLI；环境变量可覆盖路径且指错时 BLOCKED 不静默回落 | `external/connector.test.ts` |

## 尚未证明的

- 模型判断力：端到端测试用的是确定性替身，不是真实模型。真实闭环需要你自己配 API key 跑。
- 隔离强度：`utilityProcess` + 子进程**不是**容器级沙箱。`node_modules` 目前是宿主的 symlink，构建脚本以你的用户权限运行。这是原型的显式残余风险，写在 `workspace.ts:linkDependencies` 的注释里。
- 持久化：Run 事件是 JSONL，不是 SQLite WAL；没有加密、没有保留期、没有级联清理。
- 崩溃恢复：事件日志能重放，但 Core 重启后不会自动恢复进行中的 Run。
- 交叉审核收敛闭环（2 审核 + 1 整改）：收敛语义 20 条单测钉终止条件，
  authority 真实接线由 `authority.e2e.test.ts` 覆盖（阻断发现 → 实现方整改 →
  真重验 → 真重封存 → 第二轮通过，两次 PATCH_SEALED digest 不同）。
  **真实双模型下整改的质量**（改得对不对）仍只能真跑才知道 ——
  e2e 的模型是 HTTP 层脚本，钉的是平台语义，不是模型判断力。
- 挽救封存的 TIMED_OUT 路径明确不做（终态先于封存被写下），记录在案。
- 外部编码代理 CLI 连接器（`core/external/connector.ts`）：**发现 + 身份探测 +
  隔离调用 + 输出解析**已实现并有真子进程证据（见上表三行），环境自检里能看到
  本机检测到哪些 CLI。**但尚未接进交叉审核循环** —— 现在任务里能选的审核方
  仍只有模型 API profile。把连接器接成可选审核方是下一步（纯接线，语义已就位）。
- 外部 CLI 的 **CANDIDATE_AUTHOR 角色（让外部 CLI 写代码）明确不做**：
  那需要 disposable candidate workspace + single-writer epoch + normalizer，
  风险高一个量级。本切片只做 READ_ONLY_REVIEWER：只读一段 diff 文本、
  只吐结构化发现，碰不到工作区。
- 上面这些是 P1 合同 `docs/contracts/external-coding-agent-cross-review.md` 的
  **可丢弃 spike 子集，不是那份合同的实现**：没有 connector 评审流程、
  没有 terms/版本准入、没有 network manifest、没有 resource/thermal 治理。
  合同状态仍是 `P1_DEFERRED / FEATURE_DISABLED`，不因为原型跑通了就改。
- 一切 P1：Skill、多表面、Continuation、资源/热治理都没做。
- 打包只做到「能双击运行的未签名 dmg」：没有签名、没有公证、没有自动更新，
  也没有 Intel 机器上的实机验证。见下面「打包」。

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

网关对**同一条冻结路由**做有界重试（上限 3 次发送，Retry-After 优先且封顶，指数退避）：
只重发对端明确回绝的（429/5xx）和确定没离开本机的（连接被拒/DNS 失败）；
发出去了但结局不明的（连接中断、单次 240s 超时）默认不重发 —— 可能重复执行、重复计费。
重试**永远不换** provider/模型/origin，每次尝试在 egress 日志里独立落账（`sendAttempt`）。
语义与测试见 `core/model/retry.ts`。

**账本不说谎**：provider 未回报用量时（`inputTokens: null`），账本不把它折算成 0，
而是计入 `unknownUsageTurns` —— UI 上显式标注「N 轮用量未知，token 数不含它们」。
非成功终态另有封闭枚举 `failureClass`（验证未通过 / 预算耗尽 / 模型调用失败 /
用户取消…），statusReason 归人读，failureClass 归统计和 eval ——
「有多少 Run 是验证失败」不该靠 grep 中文句子回答。

### 一写一审的循环与防死循环闸门

启用交叉审核后，产品会编排「写手改 → 审核方审 → 有阻断则写手针对性整改 →
重验 → 重封存 → 再审」的互动。防死循环是两半设计：

- **自动轮次每循环硬上限**：2 次审核 + 1 次整改，流程写成直线，结构上走不满；
- **跨循环只能由人推进**：循环以 `COUNTER_EXHAUSTED` / `NO_PROGRESS` / `NO_DELTA`
  收场时，界面出现「要再循环一轮吗」——你可以授权再跑一轮，也可以直接人工审查补丁。
  平台**绝不自己"再试一次"**。累计计数（审核轮次 / 整改次数 / 用户续期次数）
  只增不清，每次续期都落一条授权事件；续到第 2 次界面会明确提示
  "连续不收敛通常该人工接手了"。

#### 一写一审的三条出口：API（推荐）/ CLI / 桌面应用

同一个厂商可能以多种形态存在，产品**动态探测**，不假设你装了 CLI：

| 出口 | 能不能自动化 | 说明 |
|---|---|---|
| **多供应商 API**（推荐） | ✅ | 最顺的路径：不依赖你装了什么、路由可冻结、用量可记账、异构随便配。用自己买的两家 key 就能跑一写一审 |
| **CLI**（`claude` / `codex`） | ✅ | 装了就能用的补充。装在非常规位置时设 `REPOPILOT_CLAUDE_CLI_PATH` / `REPOPILOT_CODEX_CLI_PATH` 指过去 |
| **桌面应用**（Claude.app / ChatGPT.app） | ❌ | 检测得到，但**用不了**：驱动它只能靠 GUI 自动化/屏幕点击，那是合同明令禁止的，也脆弱、也会动用你的登录态。检测到时会如实告诉你并指向 API |

环境自检的「交叉审核可用出口」会把三条道一起报出来，并判断你**够不够做异构
一写一审**（需要两个不同来源）。本机实测输出长这样：

```
✓ externalAgents(READY) API 已启用 1 个 provider；CLI 可用：Claude Code 2.1.207；
  桌面应用 Codex（检测到但不可自动化）
```

CLI 跑起来时的隔离是硬的：

| 外部 CLI 能看到 | 不能看到 |
|---|---|
| 一次性 synthetic HOME/XDG（用完即删） | 你真实的 HOME、`~/.claude`、登录态、历史、settings |
| 你显式配给它的那一个 API Key | 宿主环境里的任何其他凭据（`GITHUB_TOKEN`、`AWS_*`…） |
| stdin 里的补丁摘要 | 工作区、仓库 —— cwd 是那个空的一次性目录 |

环境是**整份替换**不是合并：没给的就是没有。没有显式凭据时**拒绝启动**——
绝不让它用你的宿主登录态（那会静默消耗你的订阅，还把你的 settings 带进审核）。
输出必须是结构化 JSON；解析不出来就是 `FAILED`，不会把无法解析的输出
补成"没有发现"。同厂商审核直接拒绝：异构是不变式，不是披露一下就能继续。

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

**失败也不丢工作成果**：验证失败、预算耗尽、模型调用失败、用户取消时，
工作区里的改动会被封存成**挽救补丁** —— 绑定失败的那次验证、带显式挽救标记。
它只能复制/保存后人工检视，**永远不能被接受**（`decidePatch` 只认
`AWAITING_PATCH_REVIEW`）、不能一键写回仓库（应用门禁只认接受态）——
两道既有门禁都在终态前面，挽救不会漏成第二条成功路径。
已知不做的：TIMED_OUT 路径（终态由 deadline 回调先定，封存赶不上那次落盘）。

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

## 打包（macOS，未签名 dmg）

```bash
pnpm dist:mac
```

产物在 `dist/`：`RepoPilot Prototype-<version>-arm64.dmg`（约 95MB）。

Intel 包要单独出，因为它得再下一份 x64 Electron，国内网络经常中断
（`The server aborted pending request`）：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ pnpm dist:mac:x64
```

x64 后来用上面这条镜像命令**构建成功了**，产物在本机 Rosetta 下验证过主进程与
Core（utilityProcess）都能启动 —— 首次启动约 20 秒是 Rosetta 转译开销。
**仍然没有真实 Intel 机器上的验证**。默认目标只留 arm64，是因为不挂镜像时
它是一条大概率失败的命令。

**这不是发行方案。** ADR 017 现在还是 `Open / Decision Matrix and Evidence Required` ——
Developer ID 直接分发和 Mac App Store 谁胜出没有定，签名、公证、Hardened Runtime、
最小 entitlement、更新、防降级、卸载的真实包证据按那份 ADR 排在 G5。
所以这里刻意**只**做未签名 dmg：接进签名或自动更新，等于替一个 Open 的决策提前落子。
配置里对应的取舍逐条写在 `electron-builder.yml` 的注释里。

签名只到 **ad-hoc**（`identity: '-'`），不是 Developer ID：

```
Identifier=dev.repopilot.prototype   Signature=adhoc   TeamIdentifier=not set
Sealed Resources version=2 rules=13 files=11
codesign --verify --deep --strict → 通过
spctl -a                          → rejected
```

ad-hoc 保证的是**本机自洽**（资源真的被封进签名），不构成任何分发承诺 ——
`spctl` 照样拒绝，别人下载这个 dmg 打不开。

> 踩过的坑：一开始写的是 `identity: null`。那不是"ad-hoc 签名"，是**完全跳过签名**，
> 于是 app 保留 Electron 二进制自带的 linker-signed 签名 —— `Identifier=Electron`、
> `Sealed Resources=none`，我们塞进去的 `app.asar` 压根没被封进签名，
> `spctl` 报的是 `code has no resources but signature indicates they must be present`。
> 「构建成功 + 产物损坏」，和上面那条 PATH 是同一类问题：得真去验，不能看构建退出码。

### 打包之后才暴露的一件事：GUI 应用的 PATH 不是你的 PATH

从 Finder / Dock 启动的 .app 继承的是 **launchd 的 PATH**，不是登录 shell 的。
本机 `launchctl getenv PATH` 为空，也就是系统默认的 `/usr/bin:/bin:/usr/sbin:/sbin`：

| | 终端里 | 双击 .app |
|---|---|---|
| `git` | `/opt/homebrew/bin/git` | `/usr/bin/git`（Xcode CLT shim，**还在**） |
| `node` / `npm` / `npx` | nvm 目录下 | **找不到** |
| `pnpm` | `/opt/homebrew/bin/pnpm` | **找不到** |

于是每条验证命令都会以 `SPAWN_ERROR` 收场 —— 而环境自检当时只查 `git`，
`/usr/bin/git` 永远在，自检照样全绿。**「自检全绿 + 每个任务都失败」**
正是这个项目最不能接受的那类沉默，所以补了一条 `toolchain` 检查：
它在**子进程真正会拿到的那份 PATH**（`buildChildEnv`）里逐个解析
`node / npm / npx / pnpm / yarn`，缺了就 `BLOCKED` 并给出修复办法。
负向断言在 `command.test.ts` 的 `resolveBinary` 一组里，包括直接复现
「GUI PATH 下 npm 找不到、git 还找得到」这一条。

绕开办法二选一：从终端启动，或者

```bash
sudo launchctl config user path "$PATH"
```

（后者要重启才生效，且是全局改动 —— 原型没有替你做这个决定。）

## 与文档的对应关系

代码里对不变式的强制点都标了对应的 PRD 条款，主要几处：

- `shared/domain.ts` — `RunTerminalFacts` 让 `SUCCEEDED` 在**类型层**无法脱离 verification + patch acceptance 构造（PRD-DIFF-002）
- `core/mutation.ts` — 全量模拟再落盘，失败零写入（PRD-MUT-001..004）
- `core/model/gateway.ts` — purpose + 冻结路由 + egress manifest + `automaticFallback=DENY`（PRD-MODEL-001..005）
- `core/command.ts` — 判别联合式命令结果，非零退出不可能被当成成功（PRD-RUN-002）
- `main/index.ts` — 方法白名单 + sender 绑定 + 协议版本校验（overlay §3）

`temp/neovate-code` 审计里被 Reject 的做法，这里逐条做了相反的选择：无 fuzzy apply、无绝对路径直写、无隐式覆盖、无宿主 login shell、无自动审批、无明文 header/body 日志。
