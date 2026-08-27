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

`pnpm test` — 62 个文件、1123 个测试，其中 1 个是跑真实 `tsc + vite build` 的端到端链路
（`agent.e2e.test.ts`）。Renderer 测试跑在 jsdom + Testing Library 下，是真实 DOM 断言，
不是快照比对。

| 断言 | 证据位置 |
|---|---|
| tracked-only 快照不含 `.git`，untracked 文件永不进快照 | `mutation.test.ts` / `repo.test.ts` |
| dirty worktree **直接导入**（导入不设门禁），如实记为 `DIRTY_WORKTREE` + 改动数 | `repo.test.ts` |
| **untracked 是排除不是改动**：只新建文件的仓库仍是 `CLEAN_COMMIT`，`untrackedCount` 单独报数，绝不并进 `dirtyFileCount` | `repo.test.ts` |
| 软链接记为 `SYMLINK` 而不是 `BINARY`；读不了的路径记 `UNREADABLE`；NO_VCS 枚举跳过的依赖/产物目录同样进 `excludedPaths` | `repo.test.ts` |
| 事件日志中间坏一行时，其后事件仍读得出、坏行数可查，且新事件不复用已用过的 seq | `persistence.test.ts` |
| 凭据文件读不出来时区分 `UNREADABLE`/`ABSENT`，并**拒绝写入**——磁盘字节逐字节不变 | `credentials.isolation.test.ts` |
| 非 PASS 的外部审核结论在 findings 读不出来时判不可解析，不降级成"零条阻断"的假绿灯 | `external/connector.test.ts` |
| 清理预演逐字节不动磁盘、不覆盖上一次真实清理的记录，且与真删逐项一致（含级联回收的快照） | `retention.test.ts` |
| 危险动作第一次点击只展开后果、不执行；算不出后果时**不提供**确认按钮；依据一变自动解除武装 | `ConfirmAction.test.tsx` |
| 内置 provider 不能被删除 —— 静默成功会让 Main 顺带删掉用户真实的 API Key | `registry.test.ts` |
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
| **"没给出结论" ≠ "通过"**：`INCONCLUSIVE` + 空发现 → `REVIEWER_INCONCLUSIVE`（零整改、零钩子），第 2 轮同理；`verdict:'PASS'` + 一条 blocking → 照常整改，不被 verdict 短路；e2e：审核方用满 8 轮不提交 → 事件流写 `REVIEWER_INCONCLUSIVE` 且不含 `REVIEWER_PASSED`，续期入口开着 | `agent.crossreview.test.ts` / `authority.e2e.test.ts` |
| **外部 CLI 出站的运行期同意闸门**：披露里 EXTERNAL_CLI 目的地贡献 `identityDigest`（路径+版本）而不再是 null；spawn 前现场重探，同意集合里没有它就阻断；e2e：同意之后把 CLI 升一版 → 拦在 `exportCandidate` 之前，零 candidate 目录、主线 gen 不动、简报根本没送出去 | `egress.test.ts` / `authority.external-author.e2e.test.ts` |
| 外部 CLI 隔离（**真子进程**）：外部代理看到的 HOME 不是真实 HOME、读不到 `~/.claude`、宿主凭据与 `GITHUB_TOKEN` 不在其环境、cwd 是一次性目录、调用后 HOME 被删 | `external/connector.test.ts` |
| 外部 CLI：无显式凭据拒绝启动（不以宿主登录态运行）、非零退出/不可解析输出一律 FAILED 且不编造发现、manifest 不含 raw secret 与 prompt 正文 | `external/connector.test.ts` |
| 外部 CLI：同厂商审核直接拒绝（`SAME_VENDOR_REVIEW_DENIED`），异构是不变式不是披露项 | `external/connector.test.ts` |
| 动态形态探测：**.app 内打包的 CLI 被认出来并可用**（`BUNDLED_CLI`）；bundle 里确实没 CLI 才判不可自动化；独立 CLI 优先于 bundle 内那份；env 覆盖生效且指错时 BLOCKED 不静默回落 | `external/connector.test.ts` |
| **外部作者（CANDIDATE_AUTHOR，真子进程）**："写完了" = 子进程退出 + 平台 tree diff；退出非零/超时/取消时 candidate 内容一律不读（seal=null）；退出为零时 seal 记录目录事实，作者自述只是 untrusted 备注；cwd 是 candidate 目录、HOME 一次性、只注入一个凭据、宿主 canary 不可见 | `external/author.test.ts` |
| **candidate → canonical 归一化**：MODIFIED→`REPLACE_WHOLE_FILE`+receipt、ADDED→`CREATE_FILE`、DELETED→整笔拒绝（删除是 P0 hard deny）、非 UTF-8→整笔拒绝、产物路径跳过但报数；受保护路径/范围外/stale generation/超预算一律经 `applyMutationPlan` 拒绝且主线逐字节不变 | `external/normalize.test.ts` |
| **权威层 e2e（外部作者）**：规划(内部模型)→审批→假 Codex 在 candidate 修好→归一化进主线→真验证通过→接受 `SUCCEEDED`；账本记 1 轮未知用量；自修复第二次调用的简报带失败摘要；没改→`NO_CHANGES`；碰 `.github/**`→candidate 整笔拒绝、主线零写入、`BLOCKED`；退出非零→`BLOCKED`；同厂商作者/审核方→`task.create` 拒绝；连接器不可用→拒绝而不是换内部模型 | `authority.external-author.e2e.test.ts` |
| **双审闭环（外部作者 + 模型 API 审核方）**：Codex 写 → 平台验证 → 审核方阻断 → Codex 以 REMEDIATE 简报整改（同一 candidate→归一化→CAS 路径）→ 重验 → 第二轮 PASS；`REVIEWER_PASSED`、2 审 1 改、两次 PATCH_SEALED digest 不同 | `authority.external-author.e2e.test.ts` |
| 任务输入区：外部 CLI 既可选为作者也可选为审核方（此前 Renderer 里 `reviewerConnectorId` 不可达）；不可用的连接器显示为禁用并带原因；作者与审核方撞同一连接器时审核选择被清掉 | `TaskForm.externalAuthor.test.tsx` |
| **Slice G 验证覆盖**：配置/测试/setup 按模式判为验证输入，普通源码不误判；`node check.mjs` 推出 check.mjs、`pnpm build` 推不出任何文件；flag/绝对路径/`..`/不存在的 token 不算 | `coverage.test.ts` |
| **Slice G e2e（false-green 封口）**：外部作者把验证脚本改成恒通过、源码仍 broken → 验证"通过" → 补丁 `verificationInputsTouched=['check.mjs']` + `COVERAGE_WEAKENED` → 接受只能 `ACCEPTED_UNVERIFIED`、`terminalFacts.verificationRunId=null`、导出头 `verified: NO`；内部模型走同一条路同样降级；只改源码的对照组仍 `SUCCEEDED` | `authority.coverage.e2e.test.ts` |
| 审查页：动了验证输入时"已修复"徽章旁出现横幅点名文件并说明终态；旧快照缺字段不出横幅。审批卡显示允许改动范围/受保护路径/实现方 | `RunDetail.test.tsx` |
| **Slice H 出站披露/同意**：披露确定性、对路由/审核方/作者/快照敏感、政策三项显式 UNKNOWN；外部 CLI 目的地 origin=null 且含整仓副本类别；同意覆盖的路由 = 披露里的 MODEL_API 路由 | `egress.test.ts` |
| **Slice H 网关**：无 consent → `CONSENT_MISSING`、不覆盖该冻结路由 → `CONSENT_STALE`，fetch 一次都没被调用；只有 `CONNECTIVITY_TEST` 免 consent；对话里出现 AWS key/私钥/Bearer → DLP 阻断，原因只含种类与位置、manifest 不含原文；"password" 字样与短占位符不误报 | `model/gateway.test.ts` |
| **Slice H DLP**：高置信度模式命中/不误报各一组；`redactText` 保留前缀、私钥块整段（含无 END 围栏）拿掉、脱敏后再扫不再命中 | `dlp.test.ts` |
| **Slice H 权威层 e2e**：不带同意 → `CONSENT_REQUIRED` 不建 Run；错的 digest / 加了审核方+作者后的旧 digest → `CONSENT_STALE`；RUN_CREATED 带 egressConsent（目的地/通道/中转/数据类别/UNKNOWN）；基线 stderr 里的 AWS key 在**命令层**就被脱敏 —— 事件、请求体、外部作者简报都只见 `[REDACTED:…]`；任务描述里粘 key → task.create 直接拒绝且拒绝信息不含原文 | `authority.egress.e2e.test.ts` |
| 外部 CLI 作者/审核方的 prompt 同样经 DLP：命中即 BLOCKED、子进程不起、原因不含原文 | `external/author.test.ts` |
| 任务输入区：披露常驻输入框上方；不勾同意不能发；选了作者/审核方后 digest 变、同意自动作废；披露取不到显示原因且不能发 | `TaskForm.externalAuthor.test.tsx` |
| 运行页「数据出站」面板：同意摘要 + 每次模型/CLI 出站一行，NOT_SENT 带阻断原因并列展示，token 未知不填 0 | `RunDetail.test.tsx` |
| **Slice I-1 用户命令分级**：按可执行名 + 子命令白名单分 R1–R4；`git push/merge/reset/commit`、`npm publish`、`sudo/ssh/env/aws/kubectl` → R4，`rm/chmod/mv/dd` → R3，`install/add/ci/curl/wget/docker/未知二进制` → R2（fail-closed），只有 R1 能登记为验证命令；e2e：`git push origin main`/`rm -rf dist`/`npm install x`/`sh -c` 在 task.create 被拒且不执行、不建 Run，`node check.mjs` 照常 | `commandRisk.test.ts` / `authority.coverage.e2e.test.ts` |
| **Slice K 一次性精确批准**：`cause` 把"已知危险"与"不认识它"分开 —— 只有 `UNKNOWN_BINARY` 可批；批准绑整条 argv（加一个参数即失效）、15 分钟 TTL、`maxBindings=1`（一张票只进一个 Run）、只对 BASELINE/VERIFICATION 生效；批准后 profile 里的 risk 仍是 R2，账本记的也是 R2；`command.classify` 只判级不签发，问多少次都不留票；`pnpm install`/`rm -rf`/`git push` 请求批准 → POLICY_DENIED 并说明下一步 | `commandRisk.test.ts` / `authority.commandApproval.e2e.test.ts` |
| **Slice K 闸门每次现问**：没有批准通道 / 闸门说不行 → `SPAWN_ERROR` + `passed=false`（不跑 ≠ 通过）；放行时 R2 命令真的执行（对照组）；R1 不打扰闸门；批准记录被清掉后闸门自己再查一次 | `verify.test.ts` / `authority.commandApproval.e2e.test.ts` |
| **Slice I-2 receipt 覆盖范围**：fs_read 未截断 → `FULL_BLOB`；被截断 → `BYTE_RANGE` + coveredBytes 按真正展示的行数算，并当场告诉模型不能整文件替换；BYTE_RANGE receipt 的 `REPLACE_WHOLE_FILE` → `RECEIPT_COVERAGE_INSUFFICIENT` 且逐字节不变，exact-span 仍可用，FULL_BLOB 照常通过 | `tools.test.ts` / `mutation.test.ts` |
| **Slice I-2 尾部不再被静默删**：400 行文件 fs_read 只给前 120 行 → 模型据此整文件替换被拒，`line 399` 还在 | `tools.test.ts` |
| **Slice I-2 同一账本**：平台发起的验证命令留 `verify_command` ToolCall（带 `BASELINE/VERIFICATION` role、commandId、argv）并计入预算；未登记命令与取消也留记录（取消不计账）；非 R1 的 profile 命令拒绝执行且验证不 passed；不传 recorder 行为不变 | `verify.test.ts` |
| 时间线：`verify_command` 不重复成行，合并进"另有 N 条事件没有单独成行"并点名；模型发起的 `run_command` 仍单独成行 | `Transcript.test.tsx` |
| **REQUEST_CHANGES 开新 Attempt**（不是终态）：attemptNo 递增、attemptId 换新、工作区从快照重建（gen-0）、旧补丁进 `priorPatches`（带完整 diff）、用户反馈与上一版 diff 进第二次规划的简报、预算接着用不重置、`ATTEMPT_STARTED` 事件带起始账本；第二版可被接受为 `SUCCEEDED` | `authority.attempt.e2e.test.ts` |
| REQUEST_CHANGES 的三条拒绝路径：旧补丁 digest 在新 Attempt 里不再可决定（CONFLICT）；预算已耗尽 → `BLOCKED/CHANGES_REQUESTED` 且点名是哪一项预算；恢复态 Run 可接受/拒绝但开不了新尝试 | `authority.attempt.e2e.test.ts` |
| 持久化 v3：`priorPatches` 原样往返（diff 正文必须在，事件里没有它）；v2 旧快照缺字段读回 undefined，v4 仍 fail-closed | `persistence.test.ts` |
| 审查页：历史补丁默认折叠可展开、没有时不给空壳；恢复态 Run 的"要求修改"禁用并说明原因；时间线里 `ATTEMPT_STARTED` 单独成行且切断上一轮 | `RunDetail.test.tsx` / `Transcript.test.tsx` |
| **仓库形态识别**（此前四种全是静默 fail-open）：LFS 指针按**内容**判定并排除（`.png` 下的指针归 `LFS_POINTER` 而不是 `BINARY` —— "二进制跳过了"会盖住"这个仓库用了 LFS"）；gitlink 归 `SUBMODULE` 而不是伪装成读取失败；索引有、工作区无归 `NOT_CHECKED_OUT` 而不是 `UNREADABLE`；仅大小写不同且同 inode 的整组归 `CASE_COLLISION`（不同 inode 不误伤） | `repo.test.ts` |
| **宿主 LFS 指针的两道闸**：导入时不进快照（工作区里根本没有它）；即便补丁带同路径"新建文件"，`git apply --check` 整笔拒绝、宿主指针逐字节不变、`git status` 干净 | `apply.test.ts` |
| 形态缺席对人对模型都说清楚：导入页每种形态一条横幅（LFS 用错误色并给 `git lfs pull`）、任务创建各发一条 NOTE、模型简报里点名"这些不在快照里，不要假设它们存在" | `repo.test.ts`（`summarizeShapes`）/ `App.tsx` / `agent.ts` |

## 尚未证明的

- 模型判断力：端到端测试用的是确定性替身，不是真实模型。真实闭环需要你自己配 API key 跑。
- 隔离强度：`utilityProcess` + 子进程**不是**容器级沙箱。`node_modules` 目前是宿主的 symlink，构建脚本以你的用户权限运行。这是原型的显式残余风险，写在 `workspace.ts:linkDependencies` 的注释里。
- 持久化：Run 事件是 JSONL，不是 SQLite WAL；**没有加密**。保留期与级联清理已经有了
  （`retention.ts`：证据 30 天、工作区终态后 60 分钟宽限、快照引用计数归零才删，
  逐项结果，任何一项失败或被上限截断整体只能是 `INCOMPLETE`），但那是原型语义，
  不是 overlay §4 要求的 encrypted artifact root。
- 崩溃恢复：事件日志能重放，Run 能读回来并标 `restored`，但**不能续跑** ——
  进行中的 Run 重启后落成 `INTERRUPTED`，不是从断点继续。
- 交叉审核收敛闭环（2 审核 + 1 整改）：收敛语义 20 条单测钉终止条件，
  authority 真实接线由 `authority.e2e.test.ts` 覆盖（阻断发现 → 实现方整改 →
  真重验 → 真重封存 → 第二轮通过，两次 PATCH_SEALED digest 不同）。
  **真实双模型下整改的质量**（改得对不对）仍只能真跑才知道 ——
  e2e 的模型是 HTTP 层脚本，钉的是平台语义，不是模型判断力。
- 挽救封存的 TIMED_OUT 路径明确不做（终态先于封存被写下），记录在案。
- 外部编码代理 CLI 连接器（`core/external/connector.ts`）：**发现 + 身份探测 +
  隔离调用 + 输出解析**已实现并有真子进程证据（见上表三行）。它**已经接进交叉审核
  循环** —— `crossreview.reviewers` 会把模型 API profile 与本机检测到的 CLI 一起报出来
  （不可用的也报，带原因），`task.create` 的 `reviewerConnectorId` 可以选中一个 CLI 当
  只读审核方，同厂商仍被硬拒。循环本身对"谁在审"无知，两条路走同一套归一化发现。
  **尚未证明的是真实 CLI 的审核质量**：测试钉的是隔离、失败分类与不编造发现，
  不是它挑出来的问题对不对。
- 外部 CLI 的 **CANDIDATE_AUTHOR 角色（让 Codex / Claude CLI 写代码）已做成 spike 子集**
  （`core/external/author.ts` + `normalize.ts`），边界按 TD-DEC-016：外部作者只在
  `workspace.exportCandidate()` 导出的一次性目录里改；退出后平台做 tree diff，
  把差异归一化成 `REPLACE_WHOLE_FILE`/`CREATE_FILE` 走 `applyMutationPlan`
  （receipt、digest CAS、protected/allowed path、预算、失败零写入全部照旧），
  删除/二进制整笔拒绝。**"作者写完了"的唯一来源是子进程退出 + tree diff**，
  作者输出的 JSON 只是 untrusted 备注。规划/审批/验证/封存/交叉审核全部不变；
  整改也由同一外部作者执行。**尚未证明的**：真实 Codex/Claude CLI 的改动质量
  （e2e 的作者是 shell 脚本，钉的是边界不是判断力）；各家 CLI 的非交互/沙箱 flag
  随版本漂移（`authorArgv` 写死在描述符里，漂移表现为 FAILED/TIMED_OUT，不会假绿）；
  外部作者是**结果层治理**（diff 归一化 + 验证），没有内部 Agent 那种逐 tool call
  的动作层审批 —— 这是 DEC-013 需要明写的取舍，不是已接受的决议。
- 上面这些是 P1 合同 `docs/contracts/external-coding-agent-cross-review.md` 的
  **可丢弃 spike 子集，不是那份合同的实现**：没有 connector 评审流程、
  没有 terms/版本准入、没有 network manifest、没有 resource/thermal 治理。
  合同状态仍是 `P1_DEFERRED / FEATURE_DISABLED`，不因为原型跑通了就改。
- 出站治理（Slice H）做到的是：披露 + 精确同意 + 高置信度 DLP（命令输出脱敏、含凭据文件拒读、
  网关与外部 CLI prompt 最后一道拦截）+ 运行页逐笔出站视图。**没做的**：供应商保留/训练/地域政策
  （披露里显式 UNKNOWN，不编）、低置信度/高熵启发式 DLP、`contextFileRefs` 的真实填充
  （manifest 里仍是 `[]`，文件片段走的是 tool_result 文本）、持久化 artifact 的加密。
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

### 自检与数据隔离

```bash
pnpm selftest
```

自检走**完全相同**的 Main → Core → IPC 通道，跑只读方法、造一个真实 Run、杀掉 Core
再确认它能被读回来，最后确认 Renderer 真的挂载了（不是白屏）。

它**永远不会写你的真实数据目录**：启动 Core 之前会先创建一次性 data root
（`REPOPILOT_DATA_ROOT`），结束时无论成功、失败还是抛异常都在 `finally` 里删掉。
想自己指定位置就先设好这个环境变量，此时自检不会替你删：

```bash
REPOPILOT_DATA_ROOT=/tmp/rp-check pnpm selftest
```

隔离同时覆盖凭据文件 —— `credentials.bin` 跟着受管根走，不再固定在
`~/Library/Application Support/RepoPilotPrototype/`。本机 `safeStorage` 不可用时，
写入型用例明确报 `SKIP`（环境不具备），不是伪装成通过，也不再抛未处理的 rejection。

> 边界：`pnpm selftest` 需要真实 Electron 运行时，因此**不在** `pnpm test` 里。
> 它给的是"三个进程真起来了、私有 IPC 真通了"的证据，不是单元测试的替代。

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
- **跨循环只能由人推进**：循环以 `COUNTER_EXHAUSTED` / `NO_PROGRESS` / `NO_DELTA` /
  `REVIEWER_INCONCLUSIVE` 收场时，界面出现「要再循环一轮吗」——你可以授权再跑一轮，
  也可以直接人工审查补丁。平台**绝不自己"再试一次"**。累计计数（审核轮次 / 整改次数 /
  用户续期次数）只增不清，每次续期都落一条授权事件；续到第 2 次界面会明确提示
  "连续不收敛通常该人工接手了"。

**"没给出结论" ≠ "通过"。** 一轮审核怎么收场，由两条规则决定，都指向同一个原则 ——
**平台能数的东西优先于模型的自评**：

| 情形 | 收场 |
|---|---|
| 有阻断发现 | 整改，**不管 verdict 写的是什么** |
| 零阻断 + `PASS` / `CHANGES_REQUESTED` | `REVIEWER_PASSED`（提示性发现不驱动整改） |
| 零阻断 + `INCONCLUSIVE` | `REVIEWER_INCONCLUSIVE` |

第一行挡的是 `verdict: 'PASS'` 短路掉一条 CRITICAL 阻断发现 —— verdict 是模型对这轮的
一句总结，findings 是它逐条列出的证据，两者矛盾时可信的是后者。

第三行挡的是一条更隐蔽的假绿：外部审核方输出不可解析、schema 不过、模型用满 8 轮没调
`submit_review`，三处都诚实地记了 `{verdict:'INCONCLUSIVE', findings:[]}`，然后被
`blocking.length === 0` 折成 `REVIEWER_PASSED`，界面显示 **"审核方未发现阻断问题"**。
`connector.ts` 里花了整段注释堵住"`CHANGES_REQUESTED` + 读不出的 findings 被当成没意见"，
紧挨着的同形路却没堵。现在它有自己的收场、自己的文案（"审核方未给出可用结论 —— 这不是通过"），
而且**续期入口是开着的** ——"没拿到结论"的下一步恰恰就是再跑一轮。

#### 一写一审的三条出口：API（推荐）/ CLI / 桌面应用

同一个厂商可能以多种形态存在，产品**动态探测**，不假设你装了 CLI：

| 出口 | 能不能自动化 | 说明 |
|---|---|---|
| **多供应商 API**（推荐） | ✅ | 最顺的路径：不依赖你装了什么、路由可冻结、用量可记账、异构随便配。用自己买的两家 key 就能跑一写一审 |
| **CLI**（`claude` / `codex`） | ✅ | 装了就能用的补充。装在非常规位置时设 `REPOPILOT_CLAUDE_CLI_PATH` / `REPOPILOT_CODEX_CLI_PATH` 指过去 |
| **.app 内打包的 CLI** | ✅ | ChatGPT.app 的 `Contents/Resources/codex` 就是一个完整的 `codex-cli`（带 `exec` / `review` 非交互子命令）。随桌面应用分发，界面上标为「随桌面应用分发」以便与独立安装区分 |
| **纯桌面应用**（bundle 里没 CLI，如 Claude.app） | ❌ | 只能靠 GUI 自动化/屏幕点击驱动 —— 合同明令禁止，也脆弱、也会动你的登录态。检测到时如实告知并指向 API |

环境自检的「交叉审核可用出口」会把三条道一起报出来，并判断你**够不够做异构
一写一审**（需要两个不同来源）。本机实测输出长这样：

```
✓ externalAgents(READY) API 已启用 1 个 provider；
  CLI 可用：Claude Code 2.1.207 / Codex codex-cli 0.147.0-alpha.6.5
```

（这台机器上 `claude` 是独立安装的，`codex` 来自 ChatGPT.app 内打包的那份 ——
两者厂商互异，够做异构一写一审。）

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

### 自己填的验证命令：先分级，再决定要不要你点头

手填的命令不会被硬编码成 R1（那等于"填一次即永久授权"）。它按 argv 首段分级，
然后走三条不同的路：

| 分级 | 例子 | 行为 |
|---|---|---|
| R1 | `node check.mjs`、`pnpm build`、`git status` | 直接登记 |
| R2 · 未知二进制 | `bash scripts/test.sh`、`just ci`、`bazel test //...` | **可以逐条批准** |
| R2 · 联网/装依赖/容器 | `pnpm install`、`curl …`、`docker compose up` | 没有批准通道 |
| R3 / R4 | `rm -rf dist`、`git push`、`sudo …`、`npm publish` | 永不允许 |

第二行是 Slice K 加的。原因是第三行和第二行此前混在一起，而它们完全不是一回事：
白名单里没有 `bash`，挡住的不是能力（`node -e "…"` 是 R1，能干的事不比它少），
只是**用别的语言栈的人**。所以诚实的做法是把决定权交回人，然后把这个决定绑死：

- **精确**：绑整条 argv 的 digest。`bash test.sh` 的批准不覆盖 `bash test.sh -u`。
- **一次性**：`maxBindings = 1`，一张票只能进一个 Run；不写盘，进程重启即作废。
- **有时效**：15 分钟。批了不用，过期重批。
- **不越界**：只对 BASELINE / VERIFICATION 生效，**模型提出的调用借不到**。
- **不洗白**：批准是"允许它跑"，不是"把它变成 R1"。profile 里、账本里记的都还是 R2。
- **每次现问**：执行期闸门每次执行前再查一遍，不因为登记时查过就一路放行。

第三行没有批准通道，不是保守，是物理上做不到：工作区的 `node_modules` 是指向
你仓库的 symlink，`pnpm install` 会写进你**真实的**依赖树 —— 那是"宿主仓库只读"
这条不变式的破口，不是一次点击能授权的东西。界面在这里给的是下一步（先在自己仓库里装好，
RepoPilot 只读复用），不是一句"不支持"。

**与 PRD 措辞的一处显式偏离**：PRD 写的是 "TTL + max uses"，这里落成 max *bindings*。
一条验证命令在一个 Run 里本来就要跑很多次（基线、终验、每轮自修复重验、整改后重验），
给执行次数设上限等于让一次合法的重验变成 `SPAWN_ERROR` —— 那是**假红**。
要限的是"这次授权能扩散多远"，不是"这条命令跑了几遍"，所以次数照记不照拦。

### 补丁交付

接受补丁之后有三个出口：

| 方式 | 行为 |
|---|---|
| 复制到剪贴板 | 带元信息头（base、baseKind、是否验证、未验证项、apply/revert 命令）的完整 patch 文本 |
| 保存为 `.patch` | 同上，写到你选的位置 —— 但要先领一张一次性的导出票 |
| 应用到仓库 | 真的写宿主文件。二次确认 → `git apply --check` 干跑 → 通过才写 |

「保存为 `.patch`」在 08-17 审计里是个洞：主进程自己从 Core 拿到补丁全文，
自己 `writeFileSync` 到用户选的任意路径，Core 不知道这件事发生过、也没机会说不。
现在它走 **PatchExportGrant**：

| 环节 | 规则 |
|---|---|
| 签发 | `patch.exportGrant` 出票，一次性、5 分钟 TTL、绑 runId+patchId+内容 digest |
| 内容 | 只从票里拿。票过期/用过/digest 对不上 → 拒绝，主进程手上没有第二份全文 |
| 目的地 | 父目录 `realpathSync` 之后判：在项目仓库或 RepoPilot 数据根之内 → `FORBIDDEN_ROOT`；不是普通文件（符号链接、目录）→ `NOT_A_REGULAR_FILE` |
| 写入 | 同目录临时文件 + `openSync(…, 'wx')` + `renameSync`；写之前**再判一次**目的地（TOCTOU） |
| 落账 | 四种结局（写了/取消/被拒/失败）都回 `settle`，进事件流 `PATCH_EXPORTED`；记的是**文件名**，不是宿主绝对路径 |
| 出站 | 出票时跑一遍导出期 DLP，把命中的段落报给用户 —— 补丁离开应用之前的最后一道 |

"不能存进项目仓库"不是洁癖：把 `.patch` 落进被快照的仓库里，下一次导入就会把它
当成源码，而"宿主仓库只读"这条不变式在那一刻就已经破了。

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
| `SUCCEEDED` | 有**通过的**验证 **且** 用户接受了补丁 **且** 补丁没有动过验证输入 |
| `ACCEPTED_UNVERIFIED` | 用户接受了补丁，但没有机器验证支撑 —— 或者验证虽通过、补丁却修改了验证输入（`COVERAGE_WEAKENED`） |

两者都由 Core 在状态转换处强制（`authority.ts:setStatus` + `decidePatch`），构造不出违反的对象。

第三个条件是 Slice G 加的：补丁触碰 tsconfig/vite/vitest/eslint 配置、测试文件、或验证命令
argv 里点名的脚本（`node check.mjs` 的 check.mjs），封存时记进 `PatchArtifact.verificationInputsTouched`，
未验证清单第一条就是 `⚠ COVERAGE_WEAKENED`，审查页的"已修复"徽章旁边有横幅，接受后只能是
`ACCEPTED_UNVERIFIED`，导出文件头 `# verified: NO — … modified verification inputs`。
这是 08-17 审计里"全仓最短的 false-green 路径"的封口；没有做的是"用独立 task assertion 证明
覆盖没被放宽后放行"—— 原型里只有降级，没有放行。批准计划的卡片上也会显示允许改动范围
（没填限定路径 = 整个仓库）与受保护路径，批准的不只是摘要。
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
