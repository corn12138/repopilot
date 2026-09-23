import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  ModelConnectionProfile,
  ProjectRef,
  RepositoryHarnessProfile,
  RepositorySnapshot,
  RunView,
} from '@shared/domain';
import type { DataEgressDisclosure } from '@shared/domain';
import type { ObserverHandoffArtifact } from '@shared/observerProtocol';
import type { ResponsePayload, ReviewerOption } from '@shared/protocol';

type CommandClassification = ResponsePayload<'command.classify'>;
import { globMatch } from '@shared/glob';
import { RequestError, call } from '../bridge';

const DATA_CLASS_LABEL: Record<string, string> = {
  TASK_TEXT: '任务描述与验收条件',
  REPOSITORY_SNAPSHOT_EXCERPTS: '被读取的仓库文件片段',
  COMMAND_OUTPUT: '构建/测试命令输出',
  PATCH_DIFF: '补丁 diff',
  REVIEW_FINDINGS: '审核发现',
  OBSERVED_SESSION_HANDOFF: '用户确认交接的本机会话内容',
  REPOSITORY_FULL_COPY_VIA_CLI: '整个仓库的一次性副本（CLI 可读取其中任何文件）',
};

/**
 * 底部常驻的任务输入区（对话式），替代原来的整页表单。
 *
 * 表单字段一个没删 —— 验证命令、路径、验收条件、交叉审核都是这个产品的
 * 骨架而不是配置噪音 —— 只是把它们收进「高级」抽屉，给出能直接开跑的默认值。
 * 两处刻意保留在明面上：
 *   - 验证命令 chips：这是「能不能说成功」的开关，是差异化本体，不能藏；
 *   - 模型路由：路由会被冻结，选择本身是一次授权（PRD：用户手动选路，不自动 fallback）。
 */
export function Composer({
  project,
  snapshot,
  profile,
  modelProfiles,
  handoffDraft = null,
  activeRun,
  onCreated,
  onReimport,
  onOpenRun,
  onOpenSettings,
  onError,
}: {
  project: ProjectRef;
  snapshot: RepositorySnapshot;
  profile: RepositoryHarnessProfile;
  modelProfiles: ModelConnectionProfile[];
  handoffDraft?: ObserverHandoffArtifact | null;
  /** 该项目下仍在进行中的 Run（若有）—— 用来提示，避免"以为没反应"而重复创建 */
  activeRun: RunView | null;
  onCreated: (run: RunView) => void;
  /** 快照失效时的自救出口：重新导入一次（会生成新快照） */
  onReimport: () => void;
  onOpenRun: (run: RunView) => void;
  onOpenSettings: () => void;
  onError: (err: unknown) => void;
}) {
  const enabledModels = useMemo(() => modelProfiles.filter((m) => m.enabled), [modelProfiles]);
  const commandIds = useMemo(() => Object.keys(profile.commands), [profile]);

  const [goal, setGoal] = useState(handoffDraft?.suggestedGoal ?? '');
  /**
   * 默认为空 = 整个仓库都可改（受保护路径除外）。
   * 以前默认 'src/**'：用户什么都没选，却被一条看不见的规则收窄了范围 ——
   * 项目没有 src/ 目录、或修复要动根上的配置文件时，mutation 会被莫名其妙地拒。
   * 任务选项是锦上添花，不设置就必须不干扰。
   */
  const [allowedPaths, setAllowedPaths] = useState('');
  const [acceptance, setAcceptance] = useState('');
  const [selectedCommands, setSelectedCommands] = useState<string[]>(
    commandIds.includes('build') ? ['build'] : commandIds.slice(0, 1),
  );
  const [modelProfileId, setModelProfileId] = useState(enabledModels[0]?.profileId ?? '');
  const [collaborationMode, setCollaborationMode] = useState<'' | 'MANUAL_HANDOFF' | 'BOUNDED_AUTO'>('');
  const [plannerModelProfileId, setPlannerModelProfileId] = useState(enabledModels[0]?.profileId ?? '');
  /** 多行文本原文；空 = 不做交叉审核。解析后**精确匹配** —— 不做模糊匹配是本项目的底线 */
  const [reviewerInput, setReviewerInput] = useState('');
  /**
   * 本机检测到的外部编码代理 CLI（Codex / Claude Code）。既可当只读审核方，也可当作者。
   * 不可用的也保留在列表里并带原因 —— 静默消失等于"我以为能选，其实没有"。
   */
  const [externalOptions, setExternalOptions] = useState<readonly ReviewerOption[]>([]);
  /** 作者：'' = RepoPilot 内部 Agent（默认）；否则是外部 CLI 的 connectorId */
  const [authorConnectorId, setAuthorConnectorId] = useState('');
  /**
   * 数据出站披露（PRD-DATA-001）：第一笔模型出站之前，用户要看见"送什么、送给谁、我们不知道对方政策"
   * 并对**这一份**点头。披露由 Core 算（与 task.create 重算的是同一个函数），界面只展示与收集同意；
   * 路由/审核方/作者/快照任一变化 → digest 变 → 同意自动作废（checkbox 归零）。
   * 取不到披露 = 不能建任务（fail-closed），原因显示出来。
   */
  const [disclosure, setDisclosure] = useState<DataEgressDisclosure | null>(null);
  const [disclosureError, setDisclosureError] = useState<string | null>(null);
  const [consentedDigest, setConsentedDigest] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await call('crossreview.reviewers', {});
        if (!cancelled && res) setExternalOptions(res.reviewers.filter((r) => r.kind === 'EXTERNAL_CLI'));
      } catch {
        // 探测失败只意味着"没有外部选项可选"，不阻断建任务
        if (!cancelled) setExternalOptions([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  /**
   * 快照的文件清单，用于对「允许修改的路径」做**事前**命中数试算。
   *
   * 懒加载：只在任务选项弹层第一次打开时拉一次。这份清单不随输入变化，
   * 所以不需要防抖 —— 每次按键只是在内存里跑一遍 glob，代价可以忽略。
   * 拉失败不影响任何事：拿不到清单就不显示提示（少一条帮助，不是多一个错误）。
   */
  const [snapshotPaths, setSnapshotPaths] = useState<readonly string[] | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [customCommand, setCustomCommand] = useState('');
  const [useCustom, setUseCustom] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  useEffect(() => {
    if (!advancedOpen || snapshotPaths !== null) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await call('files.tree', { snapshotId: snapshot.snapshotId });
        if (!cancelled) setSnapshotPaths(res.entries.map((e) => e.path));
      } catch {
        // 拿不到清单就不给提示 —— 这是锦上添花，不该变成一条错误
        if (!cancelled) setSnapshotPaths([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [advancedOpen, snapshotPaths, snapshot.snapshotId]);
  /** 快照已被清理回收 —— 提交时才发现，就地自救 */
  const [staleSnapshot, setStaleSnapshot] = useState(false);
  const boxRef = useRef<HTMLTextAreaElement>(null);

  const customArgv = customCommand.trim().split(/\s+/).filter(Boolean);
  const hasCustom = useCustom && customArgv.length > 0;
  const unverifiedMode = selectedCommands.length === 0 && !hasCustom;

  /**
   * 自填命令的风险判级（Slice K）。判级由 Core 做 —— 界面不复制一份分级规则，
   * 那种复制迟早会漂移成"界面说可以、Core 说不行"。
   *
   * 判级是只读的，签发批准是另一个方法：所以这里可以随打字跑，不会在 Core 里堆票。
   */
  const [risk, setRisk] = useState<CommandClassification | null>(null);
  /** 已经签发、待随本次提交带走的批准。命令一改就作废 —— 批准绑的是整条 argv */
  const [approval, setApproval] = useState<{ approvalId: string; argv: string } | null>(null);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const customKey = customArgv.join(' ');
  useEffect(() => {
    // 命令变了，上一张票就不再对应它。不清掉的话界面会显示"已批准"而 Core 会拒绝
    setApproval(null);
    setApprovalError(null);
    if (!useCustom || customArgv.length === 0) {
      setRisk(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      void call('command.classify', { argv: customKey.split(' ') })
        .then((r) => {
          if (!cancelled) setRisk(r);
        })
        .catch(() => {
          // 判级失败不阻断填写：真正的闸门在 Core 的 task.create，这里只是提前告知
          if (!cancelled) setRisk(null);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // customArgv 每次渲染都是新数组，用它做依赖会每帧重跑；customKey 才是真正的输入
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useCustom, customKey]);

  const approveCustom = async () => {
    setApprovalError(null);
    try {
      const a = await call('command.requestApproval', { argv: customKey.split(' ') });
      setApproval({ approvalId: a.approvalId, argv: customKey });
    } catch (err) {
      setApprovalError(err instanceof Error ? err.message : String(err));
    }
  };
  /** 票必须对应当前这条命令 —— 中途改过字就不算数 */
  const approvedNow = approval !== null && approval.argv === customKey;

  // 选中的模型失效时（例如刚删了 key）回落到第一个可用的
  const effectiveModelId = enabledModels.some((m) => m.profileId === modelProfileId)
    ? modelProfileId
    : (enabledModels[0]?.profileId ?? '');

  /** 可选审核方：已启用且不是实现方自己（同一个 profile 一写一审没有第二意见价值） */
  const reviewerCandidates = useMemo(
    () => enabledModels.filter((m) => m.profileId !== effectiveModelId),
    [enabledModels, effectiveModelId],
  );
  /** 逐行拆分并丢掉空行 —— 多行只是输入形态，语义上仍是"一个审核方" */
  const reviewerLines = useMemo(
    () => reviewerInput.split('\n').map((l) => l.trim()).filter(Boolean),
    [reviewerInput],
  );
  const reviewerProfileId = reviewerLines.length === 1 ? reviewerLines[0]! : '';
  /** 可用的外部 CLI 审核方：不能与作者是同一个连接器（同厂商会被 Core 拒绝，这里先不给选） */
  const reviewerCliCandidates = useMemo(
    () => externalOptions.filter((o) => o.available && o.id !== authorConnectorId),
    [externalOptions, authorConnectorId],
  );
  const reviewerIsCli = reviewerCliCandidates.some((o) => o.id === reviewerProfileId);
  const reviewerResolved = reviewerCandidates.some((m) => m.profileId === reviewerProfileId) || reviewerIsCli;
  const authorOption = externalOptions.find((o) => o.id === authorConnectorId) ?? null;

  const reviewerModelForDisclosure = reviewerProfileId && reviewerResolved && !reviewerIsCli ? reviewerProfileId : '';
  const reviewerCliForDisclosure = reviewerProfileId && reviewerIsCli ? reviewerProfileId : '';
  useEffect(() => {
    if (!effectiveModelId) {
      setDisclosure(null);
      setDisclosureError('没有可用的模型路由');
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await call('egress.disclosure', {
          snapshotId: snapshot.snapshotId,
          modelProfileId: effectiveModelId,
          ...(collaborationMode
            ? { plannerModelProfileId, collaborationMode }
            : {}),
          ...(reviewerModelForDisclosure ? { reviewerModelProfileId: reviewerModelForDisclosure } : {}),
          ...(reviewerCliForDisclosure ? { reviewerConnectorId: reviewerCliForDisclosure } : {}),
          ...(authorConnectorId ? { authorConnectorId } : {}),
          ...(handoffDraft ? { handoffDigest: handoffDraft.digest } : {}),
        });
        if (cancelled) return;
        if (!res?.disclosure) {
          setDisclosure(null);
          setDisclosureError('未取得出站披露');
          return;
        }
        setDisclosure(res.disclosure);
        setDisclosureError(null);
      } catch (err) {
        if (cancelled) return;
        setDisclosure(null);
        setDisclosureError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [snapshot.snapshotId, effectiveModelId, plannerModelProfileId, collaborationMode, reviewerModelForDisclosure, reviewerCliForDisclosure, authorConnectorId, handoffDraft]);
  const consented = disclosure !== null && consentedDigest === disclosure.digest;

  /**
   * 任务选项里**真正被设置过**的条目。用于让弹层关掉之后仍然看得见 ——
   * 填完就消失等于没有反馈，用户无从判断自己填的东西有没有生效。
   * 判据是"与默认值不同"，不是"碰过这个控件"。
   */
  const configured = useMemo(() => {
    const out: Array<{ label: string; value: string }> = [];
    if (hasCustom) out.push({ label: '自定义命令', value: customCommand.trim() });
    if (allowedPaths.trim()) out.push({ label: '限定路径', value: allowedPaths.trim() });
    const acc = acceptance.split('\n').map((l) => l.trim()).filter(Boolean);
    if (acc.length > 0) out.push({ label: `验收 ${acc.length} 条`, value: acc.join('；') });
    if (reviewerProfileId && reviewerResolved) {
      out.push({ label: '交叉审核', value: reviewerProfileId });
    }
    if (collaborationMode) out.push({ label: '双 Agent', value: collaborationMode === 'MANUAL_HANDOFF' ? '逐步交接' : '有界自动' });
    if (authorOption) out.push({ label: '作者', value: `${authorOption.label}（外部 CLI）` });
    if (handoffDraft) out.push({ label: '会话交接', value: handoffDraft.digest.slice(0, 20) });
    return out;
  }, [hasCustom, customCommand, allowedPaths, acceptance, reviewerProfileId, reviewerResolved, authorOption, handoffDraft]);

  /**
   * 逐条 glob 的命中数。
   *
   * 用的是 Core 门禁那**同一个** globMatch（已搬到 shared/）—— 在界面里另写一份
   * 的话，会出现"提示说匹配上了、跑起来却 PATH_NOT_ALLOWED"，那比没有提示更糟。
   *
   * 这只是提示，**不是门禁**：`canSubmit` 一个字都没动。任务选项的既定原则是
   * "锦上添花，不设置就必须不干扰"，那也意味着填得不好不该拦住人 ——
   * 用户可能故意写一条为将来准备的路径。我们只负责如实说"它现在匹配 0 个文件"。
   */
  const pathHits = useMemo(() => {
    if (snapshotPaths === null) return null;
    const patterns = allowedPaths.split(/[,\n]/).map((p) => p.trim()).filter(Boolean);
    if (patterns.length === 0) return null;
    return patterns.map((pattern) => ({
      pattern,
      hits: snapshotPaths.filter((path) => globMatch(pattern, path)).length,
    }));
  }, [allowedPaths, snapshotPaths]);

  const canSubmit =
    goal.trim().length > 0 &&
    effectiveModelId.length > 0 &&
    // 填了但填错 / 填了多个都不放行：静默忽略等于"我以为开了交叉审核，其实没开"
    (reviewerLines.length === 0 || (reviewerLines.length === 1 && reviewerResolved)) &&
    (!collaborationMode || (plannerModelProfileId.length > 0 && reviewerResolved)) &&
    // 出站同意：没看到披露或没点头，就不能发 —— 这是 P0 契约，不是可选项
    consented &&
    // 自填命令高于 R1 时：可批准的要先批（否则提交必被 Core 拒），不可批准的直接挡住
    (!hasCustom || !risk || risk.risk === 'R1' || (risk.approvable && approvedNow)) &&
    !submitting;

  /** 按 canSubmit 的判定顺序给出第一条拦住「开始」的原因；能发时为 null */
  const blockedReason = submitting
    ? null
    : goal.trim().length === 0
      ? '先写下要修什么'
      : effectiveModelId.length === 0
        ? '先在「设置 · API」配置一个模型'
        : !(reviewerLines.length === 0 || (reviewerLines.length === 1 && reviewerResolved))
          ? '审核方填写有误（多行或不在候选里）'
          : collaborationMode && (!plannerModelProfileId || !reviewerResolved)
            ? '双 Agent 协作需要计划方和可证明异构的审核方'
          : !consented
            ? '先确认上方的数据出站披露'
            : hasCustom && risk && risk.risk !== 'R1' && !(risk.approvable && approvedNow)
              ? '自定义命令需要先批准'
              : null;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const { run } = await call('task.create', {
        projectId: project.projectId,
        snapshotId: snapshot.snapshotId,
        profileId: profile.profileId,
        modelProfileId: effectiveModelId,
        ...(collaborationMode ? { plannerModelProfileId, collaborationMode } : {}),
        goal: goal.trim(),
        /*
         * 字段保留、UI 删除。taskClass 在 Core 里**只被写入、从无读取**
         * （ipcContract 自陈"不设门禁、不进提示词"），是一个纯装饰的输入框,
         * 却占着弹层第一位和最大版面。从合同里摘掉要动 protocol / ipcContract /
         * authority / eval 四处白名单,收益全在 UI 侧 —— 不值得,所以固定传空串。
         */
        taskClass: '',
        allowedPaths: allowedPaths
          .split(/[,\n]/)
          .map((s) => s.trim())
          .filter(Boolean),
        acceptance: acceptance
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
        verificationCommandIds: hasCustom ? [...selectedCommands, 'user1'] : selectedCommands,
        ...(hasCustom
          ? { customCommands: [{ label: customCommand.trim(), argv: customArgv }] }
          : {}),
        ...(hasCustom && approvedNow ? { commandApprovalIds: [approval!.approvalId] } : {}),
        ...(reviewerProfileId
          ? reviewerIsCli
            ? { reviewerConnectorId: reviewerProfileId }
            : { reviewerModelProfileId: reviewerProfileId }
          : {}),
        ...(authorConnectorId ? { authorConnectorId } : {}),
        ...(handoffDraft
          ? { handoffPayload: handoffDraft.payload, handoffDigest: handoffDraft.digest }
          : {}),
        egressConsentDigest: disclosure!.digest,
      });
      setGoal('');
      /*
       * 验收条件是**逐任务**的,粘到下一个不相关的任务上是错的。
       * 其余几项（路由、限定路径、作者、审核方）作为偏好粘住是合理的,不清。
       */
      setAcceptance('');
      setStaleSnapshot(false);
      onCreated(run);
    } catch (err) {
      // 快照被保留策略回收后，界面手里的 snapshotId 就是悬空的。
      // 这不是"未知错误"，是有明确下一步的状态：就地给出重新导入的按钮，
      // 而不是把一条红色堆栈丢给用户自己琢磨。
      if (err instanceof RequestError && err.code === 'CONFLICT' && err.message.includes('快照')) {
        setStaleSnapshot(true);
      } else {
        onError(err);
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (enabledModels.length === 0) {
    return (
      <div className="composer">
        <div className="composer-empty">
          还没有可用的模型连接 ——{' '}
          <button className="linklike" onClick={onOpenSettings}>
            去「设置 · API」填一个 Key
          </button>
          ，填完即生效。
        </div>
      </div>
    );
  }

  return (
    <div className="composer">
      {staleSnapshot && (
        <div className="composer-note" style={{ color: 'var(--state-warning-fg)' }}>
          这个项目的快照已被数据保留清理回收，不能再用它建任务。
          <button
            className="linklike"
            onClick={() => {
              setStaleSnapshot(false);
              onReimport();
            }}
          >
            重新导入
          </button>
          后即可继续（会生成一个新快照）。
        </div>
      )}

      {activeRun && (
        <div className="composer-note">
          这个项目有一个进行中的运行（{activeRun.title || activeRun.runId}）。
          <button className="linklike" onClick={() => onOpenRun(activeRun)}>
            查看它
          </button>
          ，或在下面开一个新任务 —— 两者互不影响。
        </div>
      )}

      {handoffDraft && (
        <div className="composer-note" role="status">
          已附加来自 {handoffDraft.vendor === 'CLAUDE_JOURNAL' ? 'Claude' : 'Codex'} 的冻结交接包
          （{handoffDraft.source === 'DESKTOP_LOCAL_AGENT' ? 'Desktop' : handoffDraft.source === 'USER_CLI' ? 'CLI' : '来源待确认'}，
          <code>{handoffDraft.digest.slice(0, 20)}…</code>）。重新导入已捕获对方写完后的仓库状态；
          交接内容会在出站披露中单独列出，并由 Core 重算摘要。
        </div>
      )}

      {/* 验证命令：明面控件。这不是配置项，是"成功"二字的定义域 */}
      <div className="composer-chips">
        <span className="composer-chips-label">验证</span>
        {commandIds.map((id) => (
          <button
            key={id}
            type="button"
            className={`chip ${selectedCommands.includes(id) ? 'selected' : ''}`}
            // chip 是开关，不是链接：选中状态必须进入无障碍树，不能只体现为颜色。
            aria-pressed={selectedCommands.includes(id)}
            title={profile.commands[id]!.label}
            onClick={() =>
              setSelectedCommands((prev) =>
                prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
              )
            }
          >
            {id}
          </button>
        ))}
        {/*
          三态如实显示。之前只有"选中/未选中"两态，于是"开了但没填"看起来
          和"已生效"一模一样 —— 而它实际上什么也没做（hasCustom 要求 argv 非空）。
          界面说生效、实际不生效，是最坏的一种模糊。
        */}
        <button
          type="button"
          className={`chip ${hasCustom ? 'selected' : useCustom ? 'pending' : ''}`}
          // 按"开关是否打开"播报；填没填由可见文案交代，不混进 pressed 语义。
          aria-pressed={useCustom}
          title={
            hasCustom
              ? `自定义验证命令：${customCommand}`
              : useCustom
                ? '已打开自定义，但还没填命令 —— 现在不会生效'
                : '添加一条自己的验证命令'
          }
          onClick={() => setUseCustom((v) => !v)}
        >
          {hasCustom
            ? `自定义 · ${customCommand.length > 24 ? `${customCommand.slice(0, 24)}…` : customCommand}`
            : useCustom
              ? '自定义 · 未填写'
              : '+ 自定义'}
        </button>
        {unverifiedMode && (
          <span className="composer-unverified" title="没有验证命令时，终态最多是 ACCEPTED_UNVERIFIED，不会是 SUCCEEDED">
            未验证模式：无法证明"修好了"
          </span>
        )}
      </div>

      {/*
        自定义验证命令是「验证」这一行的展开态，不是一项任务选项。
        它此前住在弹层里,但**只能由外面这行的 chip 打开** —— 一个"从外面开、
        在里面填"的字段没有理由待在那儿:点了 chip 还得再去弹层找输入框。
        搬回它所属的那一行,顺带去掉 chip 点击时 setAdvancedOpen(true) 的副作用。
      */}
      {useCustom && (
        <div className="field">
          <label>自定义验证命令</label>
          <input
            value={customCommand}
            placeholder="例如：pnpm --filter web build（按空格拆成 argv，不经过 shell）"
            onChange={(e) => setCustomCommand(e.target.value)}
          />
          {risk && risk.risk !== 'R1' && (
            <div className={`banner ${risk.approvable ? 'warn' : 'err'}`} role="status">
              <strong>
                {risk.approvable ? `需要你逐条批准（${risk.risk}）` : `不能作为验证命令（${risk.risk}）`}
              </strong>
              <div>{risk.reason}</div>
              {risk.remediation && <div className="help">{risk.remediation}</div>}
              {risk.approvable &&
                (approvedNow ? (
                  <div className="help">
            已批准「{customKey}」—— 一次性，只对本次运行有效；改动命令内容需要重批。
                  </div>
                ) : (
                  <>
            <button type="button" className="chip" onClick={() => void approveCustom()}>
              我了解风险，批准这一条
            </button>
            <div className="help">
              批准绑定整条命令（多一个参数就是另一条），15 分钟内有效，只能进这一个任务，
              执行次数全部进事件流。
            </div>
                  </>
                ))}
              {approvalError && <div className="help">批准失败：{approvalError}</div>}
            </div>
          )}
        </div>
      )}

      {/* 出站披露与同意：必须在明面上，不进高级抽屉 —— 它决定的是"什么会离开这台机器" */}
      <div className="composer-disclosure" data-testid="egress-disclosure">
        {disclosure ? (
          <>
            <label className="composer-consent">
              <input
                type="checkbox"
                checked={consented}
                onChange={(e) => setConsentedDigest(e.target.checked ? disclosure.digest : null)}
                aria-describedby="egress-disclosure-detail"
              />
              <span>
                我确认：本任务会把数据发往{' '}
                {disclosure.destinations.map((d, i) => (
                  <span key={`${d.role}-${i}`}>
                    {i > 0 ? '、' : ''}
                    <b>{d.label}</b>
                    {d.channel === 'MODEL_API'
                      ? `（${d.isRelay ? '第三方中转' : '官方'} · ${d.origin}）`
                      : '（本机 CLI 自行出站，端点由它决定）'}
                  </span>
                ))}
                ；保留/训练/地域政策：<b>未知</b>
              </span>
            </label>
            <details id="egress-disclosure-detail" className="composer-disclosure-detail">
              <summary>会送出哪些数据 · 披露 {disclosure.digest.slice(0, 16)}</summary>
              <ul className="plain">
                {disclosure.destinations.map((d, i) => (
                  <li key={`${d.role}-${i}`}>
                    <b>{d.role === 'PLANNER' ? '计划方' : d.role === 'IMPLEMENTER' ? '实现方' : d.role === 'REVIEWER' ? '审核方' : '作者'}</b> {d.label}：
                    {d.dataClasses.map((c) => DATA_CLASS_LABEL[c] ?? c).join('、')}
                  </li>
                ))}
                {disclosure.crossReviewParity && (
                  <li>
                    <b>写审厂商</b>：
                    {disclosure.crossReviewParity.kind === 'HETEROGENEOUS'
                      ? '已证异构'
                      : disclosure.crossReviewParity.kind === 'SAME_VENDOR'
                        ? '同厂商，第二意见价值有限'
                        : '无法判定'}
                    {' —— '}
                    {disclosure.crossReviewParity.detail}
                  </li>
                )}
                <li>快照 {disclosure.snapshotId.slice(0, 12)} 共 {disclosure.snapshotFileCount} 个文件；只有被读取的片段会离开本机，每次出站在运行页"数据出站"里逐笔可查</li>
                <li>高置信度凭据（AWS key / 私钥 / token）在命令输出里会被脱敏，在文件里会拒绝读入，出站前再扫一遍</li>
              </ul>
            </details>
            {/* 披露一变勾选即作废（digest 对不上）。作废不能静默 —— 说清"你确认的是旧披露" */}
            {consentedDigest !== null && !consented && (
              <span className="composer-disclosure-error" role="status">
                披露内容已变化（路由 / 审核方 / 作者 / 快照之一变了）——
                你此前的确认针对的是旧披露，请重新阅读上面这份并再次勾选。
              </span>
            )}
            {/* 选了审核方但披露里没有 REVIEWER 目的地 = 创建时会被降级为不审核。降级不能静默 */}
            {reviewerProfileId && reviewerResolved && !disclosure.destinations.some((d) => d.role === 'REVIEWER') && (
              <span className="composer-disclosure-error" role="status">
                所选交叉审核方不在本次披露里：该组合会在创建时降级为不审核 ——
                连接器不可用、缺该厂商凭据，或与写方证明同厂商而被异构不变式拒绝。
              </span>
            )}
          </>
        ) : (
          <span className="composer-disclosure-error" role="status">
            {disclosureError ? `无法取得出站披露：${disclosureError} —— 未确认披露不能创建任务` : '正在计算出站披露…'}
          </span>
        )}
      </div>

      <div className="composer-box">
        <textarea
          ref={boxRef}
          value={goal}
          disabled={submitting}
          placeholder={`描述要修的问题…（例：修复 ${profile.commands.build?.label ?? 'npm run build'} 失败 —— TypeScript 报 src/App.tsx 类型不匹配）\nEnter 发送，Shift+Enter 换行`}
          onChange={(e) => setGoal(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
        />
      </div>

      <div className="composer-bar">
        <div className="composer-adv-wrap">
          <button
            type="button"
            className={`composer-adv ${advancedOpen ? 'open' : ''} ${configured.length > 0 ? 'has-config' : ''}`}
            title={
              configured.length > 0
                ? `已设置：${configured.map((c) => `${c.label}（${c.value}）`).join('；')}`
                : '都有能直接开跑的默认值，可以不管'
            }
            onClick={() => setAdvancedOpen((v) => !v)}
          >
            ⚙ 任务选项
            {configured.length > 0 && <span className="adv-count">{configured.length}</span>}{' '}
            {advancedOpen ? '▾' : '▸'}
          </button>
          {/* 关掉弹层后也看得见自己设过什么 —— 不然"填了没生效"完全无感 */}
          {configured.length > 0 && !advancedOpen && (
            <span className="composer-configured">
              {configured.map((c) => (
                <span key={c.label} className="configured-chip" title={c.value}>
                  {c.label}
                </span>
              ))}
            </span>
          )}
          {advancedOpen && (
            <AdvancedPopover onClose={() => setAdvancedOpen(false)}>
              {/*
                验收条件排第一:它是弹层里**唯一填了立刻有回报**的字段 ——
                真进规划/执行/交叉审核/外部作者四处提示词。原来它排在被删掉的
                「任务类型」（纯装饰）后面。
              */}
              <div className="field">
                <label>验收条件（每行一条，可留空）</label>
                <textarea
                  value={acceptance}
                  placeholder={'不引入新的类型错误\n不修改测试文件'}
                  onChange={(e) => setAcceptance(e.target.value)}
                  style={{ minHeight: 48 }}
                />
              </div>


              <div className="field">
                <label>允许修改的路径（可留空）</label>
                <input
                  value={allowedPaths}
                  placeholder="留空 = 整个仓库都可改；填了才收窄，如 src/**"
                  onChange={(e) => setAllowedPaths(e.target.value)}
                />
                <div className="help">
                  逗号或换行分隔。无论填不填，受保护路径（{profile.protectedPaths.slice(0, 3).join(', ')}…）都禁止修改。
                </div>
                {/*
                  事前把 PATH_NOT_ALLOWED 提前到"填的时候"。
                  0 命中是最值得说的一条：写了 src/** 而仓库根本没有 src/ 时，
                  以前要等模型改到一半被整笔拒才知道。
                */}
                {pathHits && (
                  <div className="help path-hits">
                    {pathHits.map(({ pattern, hits }) => (
                      <div key={pattern} className={hits === 0 ? 'path-hits-none' : undefined}>
                        <code>{pattern}</code> —{' '}
                        {hits === 0
                          ? '匹配这份快照里的 0 个文件（是不是想写 src/** ？）'
                          : `匹配 ${hits} 个文件`}
                      </div>
                    ))}
                    <div>
                      这只是提示，不拦你提交 —— 快照共 {snapshotPaths?.length ?? 0} 个文件。
                    </div>
                  </div>
                )}
              </div>


              <div className="field">
                <label>协作推进</label>
                <div className="suggest-row">
                  <button type="button" className={`chip ${collaborationMode === '' ? 'selected' : ''}`} aria-pressed={collaborationMode === ''} onClick={() => setCollaborationMode('')}>普通任务</button>
                  <button type="button" className={`chip ${collaborationMode === 'MANUAL_HANDOFF' ? 'selected' : ''}`} aria-pressed={collaborationMode === 'MANUAL_HANDOFF'} onClick={() => setCollaborationMode('MANUAL_HANDOFF')}>双 Agent · 逐步交接</button>
                  <button type="button" className={`chip ${collaborationMode === 'BOUNDED_AUTO' ? 'selected' : ''}`} aria-pressed={collaborationMode === 'BOUNDED_AUTO'} onClick={() => setCollaborationMode('BOUNDED_AUTO')}>双 Agent · 有界自动</button>
                </div>
                {collaborationMode && (
                  <>
                    <label htmlFor="planner-route">计划方</label>
                    <select id="planner-route" value={plannerModelProfileId} onChange={(event) => setPlannerModelProfileId(event.target.value)}>
                      {enabledModels.map((model) => <option key={model.profileId} value={model.profileId}>{model.label} · {model.modelId}</option>)}
                    </select>
                    <div className="help">计划方只读；实施方和审核方仍由各自冻结身份执行。逐步交接会在下一次模型阶段前停靠。</div>
                  </>
                )}
              </div>

              <div className="field">
                <label>实现方（作者）：谁来改代码</label>
                <div className="suggest-row">
                  <button
                    type="button"
                    className={`chip ${authorConnectorId === '' ? 'selected' : ''}`}
                    aria-pressed={authorConnectorId === ''}
                    title="RepoPilot 自己的 Agent Loop：逐条 receipt + exact-span，每个工具调用都经网关"
                    onClick={() => setAuthorConnectorId('')}
                  >
                    RepoPilot 内部 Agent（默认）
                  </button>
                </div>
                {/*
                  外部作者收进折叠层,但**报数**（不变式 8）:几乎没人会用它,
                  而它无条件铺开三个 chip 加一段列不可用原因的长 help,是弹层里
                  最占版面的一块。收起来不是删 —— summary 上写清有几个、几个可用,
                  展开就能看到每个不可用的原因。
                */}
                {externalOptions.length > 0 && (
                  <details className="author-external" open={authorConnectorId !== ''}>
                    <summary>
                      外部编码代理当作者 · {externalOptions.length} 个，
                      {externalOptions.filter((o) => o.available).length} 个可用
                    </summary>
                    <div className="suggest-row">
                      {externalOptions.map((o) => (
                        <button
                          key={o.id}
                          type="button"
                          className={`chip ${authorConnectorId === o.id ? 'selected' : ''}`}
                          aria-pressed={authorConnectorId === o.id}
                          disabled={!o.available}
                          title={o.available ? o.detail : (o.reason ?? o.detail)}
                          onClick={() => {
                            setAuthorConnectorId(o.id);
                            // 作者与审核方不能是同一个连接器：把撞车的审核选择清掉并明说
                            if (reviewerProfileId === o.id) setReviewerInput('');
                          }}
                        >
                          {o.label}
                          {!o.available ? '（不可用）' : ''}
                        </button>
                      ))}
                    </div>
                    <div className="help">
                      外部 CLI 当作者时，它只在一份<b>一次性副本</b>里改，平台把差异归一化后才进主线；
                      规划、审批、验证、封存仍由平台执行。与审核方必须是不同厂商。
                      {externalOptions.some((o) => !o.available) && (
                        <>
                          {' '}
                          不可用的原因：
                          {externalOptions
                            .filter((o) => !o.available)
                            .map((o) => `${o.label} — ${o.reason ?? o.detail}`)
                            .join('；')}
                        </>
                      )}
                    </div>
                  </details>
                )}
              </div>

              <div className="field" style={{ marginBottom: 4 }}>
                <label>交叉审核：第二个模型只读审补丁</label>
                {/*
                  单选组,不是自由文本。
                  这里原本是个 textarea,而可接受的取值集合**恰好等于**下面那排 chips ——
                  自由文本唯一的增量就是"多行"和"拼错"两类必被拒的输入,于是又要写两段
                  错误提示去收拾它自己造的错。取值只能来自候选,「不做模糊匹配」这条底线
                  就从"事后报错"变成了结构上不可能,那两段提示也随之不再可达。

                  首位的 off 态 chip 是必需的:原来的 chips 挂了 aria-pressed 宣称自己是
                  开关,却只赋值不切换 —— 选中之后除了手动去 textarea 里删字,没有任何
                  关闭路径。对照作者字段,它一直有显式的「RepoPilot 内部 Agent（默认）」当 off。
                */}
                <div className="suggest-row">
                  <button
                    type="button"
                    className={`chip ${reviewerProfileId === '' ? 'selected' : ''}`}
                    aria-pressed={reviewerProfileId === ''}
                    title="不做交叉审核：补丁只经平台验证与你的判断"
                    onClick={() => setReviewerInput('')}
                  >
                    不做交叉审核（默认）
                  </button>
                  {reviewerCandidates.map((m) => (
                    <button
                      key={m.profileId}
                      type="button"
                      className={`chip ${reviewerProfileId === m.profileId ? 'selected' : ''}`}
                      aria-pressed={reviewerProfileId === m.profileId}
                      title={`${m.label} · ${m.modelId}`}
                      onClick={() => setReviewerInput(m.profileId)}
                    >
                      {m.label}
                    </button>
                  ))}
                  {reviewerCliCandidates.map((o) => (
                    <button
                      key={o.id}
                      type="button"
                      className={`chip ${reviewerProfileId === o.id ? 'selected' : ''}`}
                      aria-pressed={reviewerProfileId === o.id}
                      title={`${o.detail}（外部 CLI，只读审核）`}
                      onClick={() => setReviewerInput(o.id)}
                    >
                      {o.label}（CLI）
                    </button>
                  ))}
                </div>
                {reviewerCandidates.length === 0 && reviewerCliCandidates.length === 0 && (
                  <div className="help">
                    没有可用的第二个审核方 —— 再配一个供应商的 API Key 就有了。
                  </div>
                )}
                <div className="help">
                  审核方"通过"<b>不等于</b>验证通过，也不代表可以接受 —— 是否接受仍由你决定。
                  异构（不同供应商）的第二意见价值更高。有阻断发现时会自动整改一次并重验（上限 2 审 1 改）。
                </div>
              </div>
            </AdvancedPopover>
          )}
        </div>
        {authorOption && (
          // 全表单后果最大的选择（整仓副本交给本机 CLI）—— 与「交叉审核已开」同构的常驻标记
          <span className="composer-hint" title={`由 ${authorOption.label} 在一次性副本里改代码`}>
            外部作者：{authorOption.label}
          </span>
        )}
        {reviewerResolved && (
          <span className="composer-hint" title="补丁封存后由第二个模型只读审核">
            交叉审核已开
          </span>
        )}
        <span className="spacer" />
        <select
          className="composer-model"
          value={effectiveModelId}
          disabled={submitting}
          title="本次 Attempt 会冻结这条路由；运行中不自动切换供应商或模型"
          onChange={(e) => setModelProfileId(e.target.value)}
        >
          {enabledModels.map((m) => (
            <option key={m.profileId} value={m.profileId}>
              {m.label} · {m.modelId}
            </option>
          ))}
        </select>
        {blockedReason && (
          <span className="composer-hint" role="status">
            {blockedReason}
          </span>
        )}
        <button
          className="primary"
          disabled={!canSubmit}
          title={blockedReason ?? undefined}
          onClick={() => void submit()}
        >
          {submitting ? '创建中…' : '开始'}
        </button>
      </div>

    </div>
  );
}

/**
 * 「任务选项」弹层：向上展开、带标题栏和关闭键、点外面也能关。
 * 反馈原话是「打开后没有关闭的地方」和「不怎么高级」——
 * 前者靠 ✕ / 点击外部 / 再点按钮三条路；后者改名：里面装的是
 * 有默认值的任务配置，不是什么高级功能，名字不该端着。
 */
/** 能接收焦点的元素；`:not([disabled])` 排除被禁用控件，它们不该出现在环里。 */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function AdvancedPopover({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  /*
   * 一个弹层要能被键盘用户用完整，需要四件事，缺一件就会把人困住：
   * Escape 能关、打开时焦点进得去、Tab 不会跑到背后的页面上、关闭后焦点回到原处。
   * 之前四件都没有：打开后焦点还留在触发按钮，Tab 直接穿到底下的表单里。
   */
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const restoreTo = document.activeElement as HTMLElement | null;

    const focusables = () => [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)];
    focusables()[0]?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      // 到边界就绕回去；焦点离开弹层等于用户在操作被弹层遮住的东西。
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      // 关闭后焦点必须回到触发它的地方，否则键盘用户会被丢回文档开头。
      restoreTo?.focus?.();
    };
  }, []);

  return (
    <>
      <div className="popover-backdrop" onClick={onClose} />
      <div
        className="composer-advanced rp-enter"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="任务选项"
      >
        <div className="composer-advanced-head">
          <strong>任务选项</strong>
          <span className="composer-advanced-hint">都有能直接开跑的默认值</span>
          <span className="spacer" />
          <button type="button" onClick={onClose} aria-label="关闭">
            ✕ 收起
          </button>
        </div>
        {children}
      </div>
    </>
  );
}
