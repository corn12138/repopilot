# Project instructions

## Current phase gate

- 当前阶段是 Stage 0：Discovery + Inception。
- 在 Stage 0 评审结论明确为 Passed 且用户明确授权前，不进入业务代码实现。
- 技术 spike 只能用于验证会改变架构的高风险假设；必须先写假设、成功条件、timebox 和对 ADR 的影响，产物默认可丢弃。

## Current experience baseline

- 当前首发体验层按 **Electron + React macOS Desktop Workbench** 继续设计；Web Console 只保留为 ADR 015 的被比较替代方案，不是当前体验层基线。
- 当前用户方向进一步收窄为 **macOS 本地桌面单机产品**：P0 不建设 RepoPilot 云端后端，也不要求独立安装、常驻或监听端口的 NestJS、PostgreSQL、Redis/BullMQ、S3-compatible Artifact Store、Fastify/HTTP/WebSocket 服务。外部网络只用于用户手动配置并批准的模型 Provider/relay，以及后续经发行策略批准的更新检查。
- “不做后端”不等于删除本地 Agent 内核或把特权逻辑塞入 Renderer。当前候选是 `Renderer → typed Preload → Electron Main capability broker → controlled IPC → app-packaged Desktop Agent Core utility process`；本地状态候选为 embedded transactional store + owner-only encrypted Artifact root + macOS Keychain。该物理拓扑仍是 `Proposed`，以 `docs/architecture/local-desktop-only-topology.md` 为最新变更输入。
- ADR 015 状态是 `User-directed Proposed Baseline`，不是已实现或已通过评审的事实；它必须在进入编码前解析为 `Accepted` 或 `Rejected/Replaced`，保持 `Proposed` 时 Stage 0 Gate 仍为 `Not Ready`。
- Stage 0 只完成用户验证、桌面进程/IPC/嵌入式数据与执行边界、发行策略、威胁模型、ADR 和验收设计；只有 ADR 015=`Accepted`、ADR 017 或替代拓扑已解析、Stage 0 Gate Passed 且用户再次明确授权后，才按 Electron 基线进入 `M2 Walking Skeleton + MVP` 的第一条桌面链路。若 ADR 015=`Rejected/Replaced`，必须先同步替代体验层及其验收设计。

## Required reading

开始任何产品、架构或开发任务前，依次读取：

1. README.md
2. docs/00-project-context.md
3. docs/planning/RepoPilot-AI-Agent工程师转型与产品总体蓝图-v0.1.md
4. docs/planning/RepoPilot-Stage0-Inception设计任务书-v0.1.md
5. docs/architecture/local-desktop-only-topology.md

前四项是冻结的 r9 历史评审输入；涉及 NestJS、PostgreSQL、Redis、S3、独立本地服务、HTTP/SSE/WebSocket 或首期 Docker 必选的物理拓扑描述时，第 5 项是当前用户方向的变更输入。不得用旧 r9 物理拓扑直接初始化工程，也不得把第 5 项误写为 ADR Accepted、Gate Passed 或实现授权。

若任务是产品阶段评审、PRD/TD 对比、完整功能页审计、开发进度评估或下一阶段规划，使用全局 product-stage-auditor skill。

## Engineering truth rules

- 文档完成不等于门禁通过；评审记录、机器证据和真实用户反馈必须分开标注。
- 每个功能必须能追溯到用户问题、验收条件或安全要求。
- 每个 Run 的成功必须绑定可查询的验证证据，不能以模型声称完成作为依据。
- 模型负责非确定性判断，平台负责确定性执行；副作用必须经过策略和审批治理。
- 当前产品基线先证明单 Agent 闭环；没有对照数据前不引入 Multi-Agent。
- docs/source 下的文件是只读原始证据，不在其上直接修改或覆盖。

## Scope discipline

- 首个垂直切片只覆盖 Vite + React + TypeScript 仓库的构建或测试失败修复。
- Next.js、Remix、静态 HTML、NestJS 仓库、RAG、MCP、Skill 和平台化能力均不属于首个切片。
- P0 只交付本地 macOS Desktop；CLI/headless、IDE Extension、公开 Server/API、远程多用户、云端同步和独立后端部署均为 Deferred。
- 技术选型必须记录替代方案和 trade-off，不以流行度代替架构理由。
