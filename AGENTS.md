# 给在这个仓库里干活的人和 Agent

## 仓库现状

这里有两个东西，阶段完全不同，别混：

| | 状态 | 能不能改 |
|---|---|---|
| `prototype/` | 可运行的**产品种子**（2026-08-27 自可丢弃 spike 升格） | 能，但要守住下面列的不变式 |
| `docs/devlog/` | 开发记录，每篇独立成文 | 能，新增按 `YYYY-MM-DD-NN-短标题.md` |
| `docs/` 其余（仅本地） | Stage 0 设计文档，Gate = **Not Ready** | 改之前先读，别把原型当成决议依据 |

> `docs/` 下除 `devlog/` 外的内容**不在公开仓库里**（Stage 0 设计文档、个人材料）。
> 如果你 clone 下来看不到它们，是预期的。

## 原型有原型的边界

`prototype/` 能跑通完整闭环，但它**不是** Stage 0 通过的证明：

- ADR 001–017 目前**全部**是 `Proposed` 或 `Open`，一份 Accepted 都没有。
- `utilityProcess` + 嵌入式存储 + 发行方案都还是候选，不是已接受的决策。
- 2026-08-27 起定位是**产品种子**（08-24 定向「不另起炉灶」的落档，方向决定文档在
  docs/inception，仅本地）—— 但升格不追认技术决策，ADR 仍逐份决议。

所以：**不要因为原型这么写了，就把对应的 ADR 标成 Accepted。** 反过来也一样 ——
原型里的取舍（比如 node_modules 用宿主 symlink）是明确记录在案的残余风险，
不是推荐做法。

## 改 `prototype/` 时不能破的不变式

这些不是风格偏好，是这个项目存在的理由。改动如果绕过它们，就失去了意义：

1. **模型不能宣布成功。** `SUCCEEDED` 必须同时绑定通过的 verification 和用户接受的
   patch；没有验证只能是 `ACCEPTED_UNVERIFIED`。校验点在 `authority.ts` 的 `setStatus`。
   补丁若触碰了验证输入（配置/测试/验证脚本，见 `coverage.ts`），那次"通过"不构成
   `SUCCEEDED` 的依据，只能 `ACCEPTED_UNVERIFIED`（`decidePatch`）。
2. **不做模糊匹配。** exact-span 命中 0 次或多次一律整笔失败。见 `mutation.ts`。
   `REPLACE_WHOLE_FILE` 必须引用 `coverage=FULL_BLOB` 的 receipt —— 只读到开头就整文件覆盖，
   等于把没看过的尾部静默删掉。
3. **失败时零写入。** 事务先在内存里完整模拟，通过了才落 staged generation，
   再 CAS 切换。任何失败路径下工作区必须逐字节不变。
4. **宿主仓库只读。** 改动只发生在 `MaterializedWorkspace` 副本里。唯一的例外是
   用户显式点「应用到仓库」，那条路径走 `git apply --check` 且冲突整笔拒绝。
5. **命令结果是判别联合，不是布尔。** 非零退出、信号、超时、spawn 失败必须可区分。
   命令无论由谁发起（用户手填、模型提议、平台验证）都走同一套：先分级（`commandRisk.ts`）、
   留 ToolCall 记录、计入同一账本；验证只执行 R1。
6. **权限边界不上移。** Renderer 无 Node/FS/shell/密钥；Preload 不给通用 `invoke`；
   Main 不持有 Task/Run/Approval 权威；Core 不监听端口。
7. **凭据不落明文。** API key 只进系统钥匙串，Core 只在内存持有，
   Renderer 只看得到来源和末四位。
8. **省略要报数。** 任何截断、过滤、排除都必须显示数量和原因 ——
   静默过滤和静默通过是同一类问题。
9. **先披露、后同意、再出站。** `task.create` 必须带用户确认过的 `DataEgressDisclosure` digest
   （Core 重算比对），每次模型调用由 `ModelGateway.preflight` 校验 consent 覆盖该冻结路由；
   高置信度凭据在命令输出层脱敏（`dlp.ts`）、含凭据的文件 `fs_read` 拒读、网关与外部 CLI prompt
   最后一道拦截。P0 没有"仍然发送"。

## 工程诚实规则

- 文档写完不等于验证过。评审记录、机器证据、真实用户反馈要分开标注。
- 每个「修好了」都要有测试或运行输出撑着，别写没跑过的结论。
- 负向测试是主体。正向路径不容易错，错都错在边界上。
- 改了行为就同步改测试断言，不要让断言变成过期的装饰。
- 收口一条工作线时，同步收口它的叙事面：根 README 的功能清单 / 数字 /「还没做的」、
  devlog 索引。过期的 README 比没有 README 更糟 —— 它会以权威口吻说反话
  （08-27 重审：「还没做的」8 项里 4 项早已做完，外部代理一句已成反话）。
  `node scripts/check-devlog.mjs` 校验 devlog 文件与索引一一对应、编号不撞车。
- 自检和测试**不能留下持久化改动**（写了配置就要还原）。自检更进一步：不在真实
  data root 上跑，隔离由 `REPOPILOT_DATA_ROOT` 保证，缺隔离时写入型用例直接 `BLOCKED`。

## 范围纪律

- 首个验证切片是 Vite + React + TypeScript 的构建/测试失败修复。
  其他技术栈能导入、能跑，但没有经过验证，`supportStatus` 会如实标注。
- Multi-Agent、RAG、MCP、Skill 运行时、CLI/headless 表面都不在当前范围。
- 技术选型要记下替代方案和取舍理由，不拿流行度当论据。

## 本地开发

```bash
cd prototype
pnpm install && pnpm rebuild electron   # 国内加 ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
pnpm dev        # 启动应用
pnpm test       # 62 个文件 / 1123 个测试，含真实 tsc + vite build 的端到端链路
pnpm selftest   # 三进程 + IPC + Renderer 挂载自检；自动隔离到一次性 data root
pnpm typecheck
```

`pnpm test` 里 Renderer 部分跑在 jsdom 下，是真实 DOM 断言。`pnpm selftest` 需要
Electron 运行时，所以不在 `pnpm test` 里；它会在启动 Core 前把 `REPOPILOT_DATA_ROOT`
指向一次性目录并在 `finally` 里删掉，不碰你的真实数据与凭据。

端到端测试需要 fixture 的依赖：

```bash
cd prototype/fixtures/vite-react-broken && npm install
```
