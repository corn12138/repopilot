# 给在这个仓库里干活的人和 Agent

## 仓库现状

这里有两个东西，阶段完全不同，别混：

| | 状态 | 能不能改 |
|---|---|---|
| `prototype/` | 可运行的**可丢弃原型**（disposable spike） | 能，但要守住下面列的不变式 |
| `docs/devlog/` | 开发记录，每篇独立成文 | 能，新增按 `YYYY-MM-DD-NN-短标题.md` |
| `docs/` 其余（仅本地） | Stage 0 设计文档，Gate = **Not Ready** | 改之前先读，别把原型当成决议依据 |

> `docs/` 下除 `devlog/` 外的内容**不在公开仓库里**（Stage 0 设计文档、个人材料）。
> 如果你 clone 下来看不到它们，是预期的。

## 原型有原型的边界

`prototype/` 能跑通完整闭环，但它**不是** Stage 0 通过的证明：

- ADR 001–017 目前**全部**是 `Proposed` 或 `Open`，一份 Accepted 都没有。
- `utilityProcess` + 嵌入式存储 + 发行方案都还是候选，不是已接受的决策。
- 原型验证的是「这些设计假设成立吗」，不是「这就是产品」。

所以：**不要因为原型这么写了，就把对应的 ADR 标成 Accepted。** 反过来也一样 ——
原型里的取舍（比如 node_modules 用宿主 symlink）是明确记录在案的残余风险，
不是推荐做法。

## 改 `prototype/` 时不能破的不变式

这些不是风格偏好，是这个项目存在的理由。改动如果绕过它们，就失去了意义：

1. **模型不能宣布成功。** `SUCCEEDED` 必须同时绑定通过的 verification 和用户接受的
   patch；没有验证只能是 `ACCEPTED_UNVERIFIED`。校验点在 `authority.ts` 的 `setStatus`。
2. **不做模糊匹配。** exact-span 命中 0 次或多次一律整笔失败。见 `mutation.ts`。
3. **失败时零写入。** 事务先在内存里完整模拟，通过了才落 staged generation，
   再 CAS 切换。任何失败路径下工作区必须逐字节不变。
4. **宿主仓库只读。** 改动只发生在 `MaterializedWorkspace` 副本里。唯一的例外是
   用户显式点「应用到仓库」，那条路径走 `git apply --check` 且冲突整笔拒绝。
5. **命令结果是判别联合，不是布尔。** 非零退出、信号、超时、spawn 失败必须可区分。
6. **权限边界不上移。** Renderer 无 Node/FS/shell/密钥；Preload 不给通用 `invoke`；
   Main 不持有 Task/Run/Approval 权威；Core 不监听端口。
7. **凭据不落明文。** API key 只进系统钥匙串，Core 只在内存持有，
   Renderer 只看得到来源和末四位。
8. **省略要报数。** 任何截断、过滤、排除都必须显示数量和原因 ——
   静默过滤和静默通过是同一类问题。

## 工程诚实规则

- 文档写完不等于验证过。评审记录、机器证据、真实用户反馈要分开标注。
- 每个「修好了」都要有测试或运行输出撑着，别写没跑过的结论。
- 负向测试是主体。正向路径不容易错，错都错在边界上。
- 改了行为就同步改测试断言，不要让断言变成过期的装饰。
- 自检和测试**不能留下持久化改动**（写了配置就要还原）。

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
pnpm test       # 44 个测试，含真实 tsc + vite build 的端到端链路
pnpm selftest   # 三进程 + IPC + Renderer 挂载自检
pnpm typecheck
```

端到端测试需要 fixture 的依赖：

```bash
cd prototype/fixtures/vite-react-broken && npm install
```
