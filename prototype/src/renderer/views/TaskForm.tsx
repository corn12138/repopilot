import { useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  ModelConnectionProfile,
  ProjectRef,
  RepositoryHarnessProfile,
  RepositorySnapshot,
  RunView,
  TaskClass,
} from '@shared/domain';
import { call } from '../bridge';

const TASK_CLASS_LABEL: Record<TaskClass, string> = {
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
  onOpenRun: (run: RunView) => void;
  onOpenSettings: () => void;
  onError: (err: unknown) => void;
}) {
  const enabledModels = useMemo(() => modelProfiles.filter((m) => m.enabled), [modelProfiles]);
  const commandIds = useMemo(() => Object.keys(profile.commands), [profile]);

  const [goal, setGoal] = useState('');
  const [taskClass, setTaskClass] = useState<TaskClass>(
    profile.supportedTaskClasses[0] ?? 'BUILD_FAILURE_FIX',
  );
  const [allowedPaths, setAllowedPaths] = useState('src/**');
  const [acceptance, setAcceptance] = useState('');
  const [selectedCommands, setSelectedCommands] = useState<string[]>(
    commandIds.includes('build') ? ['build'] : commandIds.slice(0, 1),
  );
  const [modelProfileId, setModelProfileId] = useState(enabledModels[0]?.profileId ?? '');
  const [reviewerProfileId, setReviewerProfileId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [customCommand, setCustomCommand] = useState('');
  const [useCustom, setUseCustom] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const boxRef = useRef<HTMLTextAreaElement>(null);

  const customArgv = customCommand.trim().split(/\s+/).filter(Boolean);
  const hasCustom = useCustom && customArgv.length > 0;
  const unverifiedMode = selectedCommands.length === 0 && !hasCustom;

  // 选中的模型失效时（例如刚删了 key）回落到第一个可用的
  const effectiveModelId = enabledModels.some((m) => m.profileId === modelProfileId)
    ? modelProfileId
    : (enabledModels[0]?.profileId ?? '');

  const canSubmit = goal.trim().length > 0 && effectiveModelId.length > 0 && !submitting;

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
      onCreated(run);
    } catch (err) {
      onError(err);
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
                <label>任务类型</label>
                <select value={taskClass} onChange={(e) => setTaskClass(e.target.value as TaskClass)}>
                  {profile.supportedTaskClasses.map((c) => (
                    <option key={c} value={c}>
                      {TASK_CLASS_LABEL[c]}
                    </option>
                  ))}
                </select>
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
                <label>允许修改的路径</label>
                <input value={allowedPaths} onChange={(e) => setAllowedPaths(e.target.value)} />
                <div className="help">
                  逗号或换行分隔。受保护路径（{profile.protectedPaths.slice(0, 3).join(', ')}…）无论如何都禁止修改。
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
                <label>交叉审核：第二个模型只读审补丁</label>
                <select value={reviewerProfileId} onChange={(e) => setReviewerProfileId(e.target.value)}>
                  <option value="">不做交叉审核</option>
                  {enabledModels
                    .filter((m) => m.profileId !== effectiveModelId)
                    .map((m) => (
                      <option key={m.profileId} value={m.profileId}>
                        {m.label} · {m.modelId}
                      </option>
                    ))}
                </select>
                <div className="help">
                  审核方"通过"<b>不等于</b>验证通过，也不代表可以接受 —— 是否接受仍由你决定。
                  异构（不同供应商）的第二意见价值更高。有阻断发现时会自动整改一次并重验（上限 2 审 1 改）。
                </div>
              </div>
            </AdvancedPopover>
          )}
        </div>
        {reviewerProfileId && (
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
