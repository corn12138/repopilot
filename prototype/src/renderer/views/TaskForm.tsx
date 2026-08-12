import { useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  ModelConnectionProfile,
  ProjectRef,
  RepositoryHarnessProfile,
  RepositorySnapshot,
  RunView,
  TaskClass,
} from '@shared/domain';
import { COMMON_TASK_CLASSES } from '@shared/domain';
import { RequestError, call } from '../bridge';

/** 常见值的中文说明，仅用于 datalist 的提示文案 —— 不是可选项清单 */
const TASK_CLASS_HINT: Record<string, string> = {
  BUILD_FAILURE_FIX: '构建失败修复',
  TEST_FAILURE_FIX: '测试失败修复',
  TYPE_ERROR_FIX: '类型错误修复',
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

  const [goal, setGoal] = useState('');
  // 默认留空：它不设门禁也不进提示词，预填一个值只会让人以为"必须选一个"
  const [taskClass, setTaskClass] = useState<TaskClass>('');
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
  /** 多行文本原文；空 = 不做交叉审核。解析后**精确匹配** —— 不做模糊匹配是本项目的底线 */
  const [reviewerInput, setReviewerInput] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [customCommand, setCustomCommand] = useState('');
  const [useCustom, setUseCustom] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  /** 快照已被清理回收 —— 提交时才发现，就地自救 */
  const [staleSnapshot, setStaleSnapshot] = useState(false);
  const boxRef = useRef<HTMLTextAreaElement>(null);

  const customArgv = customCommand.trim().split(/\s+/).filter(Boolean);
  const hasCustom = useCustom && customArgv.length > 0;
  const unverifiedMode = selectedCommands.length === 0 && !hasCustom;

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
  const reviewerResolved = reviewerCandidates.some((m) => m.profileId === reviewerProfileId);

  const canSubmit =
    goal.trim().length > 0 &&
    effectiveModelId.length > 0 &&
    // 填了但填错 / 填了多个都不放行：静默忽略等于"我以为开了交叉审核，其实没开"
    (reviewerLines.length === 0 || (reviewerLines.length === 1 && reviewerResolved)) &&
    !submitting;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const { run } = await call('task.create', {
        projectId: project.projectId,
        snapshotId: snapshot.snapshotId,
        profileId: profile.profileId,
        modelProfileId: effectiveModelId,
        goal: goal.trim(),
        taskClass,
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
        ...(reviewerProfileId ? { reviewerModelProfileId: reviewerProfileId } : {}),
      });
      setGoal('');
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
        <div className="composer-note" style={{ color: 'var(--warn)' }}>
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

      {/* 验证命令：明面控件。这不是配置项，是"成功"二字的定义域 */}
      <div className="composer-chips">
        <span className="composer-chips-label">验证</span>
        {commandIds.map((id) => (
          <button
            key={id}
            type="button"
            className={`chip ${selectedCommands.includes(id) ? 'selected' : ''}`}
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
        <button
          type="button"
          className={`chip ${useCustom ? 'selected' : ''}`}
          onClick={() => {
            setUseCustom((v) => !v);
            setAdvancedOpen(true);
          }}
        >
          + 自定义
        </button>
        {unverifiedMode && (
          <span className="composer-unverified" title="没有验证命令时，终态最多是 ACCEPTED_UNVERIFIED，不会是 SUCCEEDED">
            未验证模式：无法证明"修好了"
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
            className={`composer-adv ${advancedOpen ? 'open' : ''}`}
            onClick={() => setAdvancedOpen((v) => !v)}
          >
            ⚙ 任务选项 {advancedOpen ? '▾' : '▸'}
          </button>
          {advancedOpen && (
            <AdvancedPopover onClose={() => setAdvancedOpen(false)}>
              <div className="field">
                <label>任务类型（可留空，也可自己写）</label>
                <textarea
                  value={taskClass}
                  rows={2}
                  placeholder={'例如：构建失败修复\n也可以写长一点：文档站升级 vite 后样式回归，只在生产构建复现'}
                  onChange={(e) => setTaskClass(e.target.value)}
                />
                {/* 建议值用 chips 而不是 datalist：不点也看得见，且不会让输入框长得像下拉 */}
                <div className="suggest-row">
                  {[...new Set([...profile.supportedTaskClasses, ...COMMON_TASK_CLASSES])].map((c) => (
                    <button
                      key={c}
                      type="button"
                      className="chip"
                      title={TASK_CLASS_HINT[c] ?? c}
                      onClick={() => setTaskClass(TASK_CLASS_HINT[c] ?? c)}
                    >
                      {TASK_CLASS_HINT[c] ?? c}
                    </button>
                  ))}
                </div>
                <div className="help">
                  纯描述性元数据，不设门禁、也不进提示词 —— 写你自己的说法就行，
                  上面几个只是常见写法。
                </div>
              </div>

              {useCustom && (
                <div className="field">
                  <label>自定义验证命令</label>
                  <input
                    value={customCommand}
                    placeholder="例如：pnpm --filter web build（按空格拆成 argv，不经过 shell）"
                    onChange={(e) => setCustomCommand(e.target.value)}
                  />
                </div>
              )}

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
              </div>

              <div className="field">
                <label>验收条件（每行一条，可留空）</label>
                <textarea
                  value={acceptance}
                  placeholder={'不引入新的类型错误\n不修改测试文件'}
                  onChange={(e) => setAcceptance(e.target.value)}
                  style={{ minHeight: 48 }}
                />
              </div>

              <div className="field" style={{ marginBottom: 4 }}>
                <label>交叉审核：第二个模型只读审补丁（可留空）</label>
                <textarea
                  value={reviewerInput}
                  rows={2}
                  placeholder={'留空 = 不做交叉审核\n填一个审核方 id，例如 profile_anthropic（下面可点）'}
                  onChange={(e) => setReviewerInput(e.target.value)}
                />
                <div className="suggest-row">
                  {reviewerCandidates.length === 0 ? (
                    <span className="help" style={{ padding: 0 }}>
                      没有可用的第二个审核方 —— 再配一个供应商的 API Key 就有了。
                    </span>
                  ) : (
                    reviewerCandidates.map((m) => (
                      <button
                        key={m.profileId}
                        type="button"
                        className={`chip ${reviewerProfileId === m.profileId ? 'selected' : ''}`}
                        title={`${m.label} · ${m.modelId}`}
                        onClick={() => setReviewerInput(m.profileId)}
                      >
                        {m.label}
                      </button>
                    ))
                  )}
                </div>
                {reviewerLines.length > 1 && (
                  // 多行是输入形态，不是"支持多个审核方"—— 别静默只取第一行
                  <div className="help" style={{ color: 'var(--err)' }}>
                    目前只支持一个审核方，这里填了 {reviewerLines.length} 个。
                  </div>
                )}
                {reviewerLines.length === 1 && !reviewerResolved && (
                  // 不做模糊匹配：填错就明说，并列出可用的，不静默忽略
                  <div className="help" style={{ color: 'var(--err)' }}>
                    没有这个审核方。可用：{reviewerCandidates.map((m) => m.profileId).join('、') || '（无）'}
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
        <button className="primary" disabled={!canSubmit} onClick={() => void submit()}>
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
function AdvancedPopover({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  return (
    <>
      <div className="popover-backdrop" onClick={onClose} />
      <div className="composer-advanced" role="dialog" aria-label="任务选项">
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
