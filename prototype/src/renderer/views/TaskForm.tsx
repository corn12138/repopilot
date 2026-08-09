import { useMemo, useState } from 'react';
import type {
  ModelConnectionProfile,
  ProjectRef,
  RepositoryHarnessProfile,
  RepositorySnapshot,
  RunView,
  TaskClass,
} from '@shared/domain';
import { call } from '../bridge';
import { Banner, Card } from '../components/common';

const TASK_CLASS_LABEL: Record<TaskClass, string> = {
  BUILD_FAILURE_FIX: '构建失败修复',
  TEST_FAILURE_FIX: '测试失败修复',
  TYPE_ERROR_FIX: '类型错误修复',
};

export function TaskForm({
  project,
  snapshot,
  profile,
  modelProfiles,
  onCreated,
  onError,
}: {
  project: ProjectRef;
  snapshot: RepositorySnapshot;
  profile: RepositoryHarnessProfile;
  modelProfiles: ModelConnectionProfile[];
  onCreated: (run: RunView) => void;
  onError: (err: unknown) => void;
}) {
  const enabledModels = useMemo(() => modelProfiles.filter((m) => m.enabled), [modelProfiles]);
  const commandIds = useMemo(() => Object.keys(profile.commands), [profile]);

  const [goal, setGoal] = useState('');
  const [taskClass, setTaskClass] = useState<TaskClass>(profile.supportedTaskClasses[0] ?? 'BUILD_FAILURE_FIX');
  const [allowedPaths, setAllowedPaths] = useState('src/**');
  const [acceptance, setAcceptance] = useState('');
  const [selectedCommands, setSelectedCommands] = useState<string[]>(
    commandIds.includes('build') ? ['build'] : commandIds.slice(0, 1),
  );
  const [modelProfileId, setModelProfileId] = useState(enabledModels[0]?.profileId ?? '');
  /** 空串 = 不做交叉审核 */
  const [reviewerProfileId, setReviewerProfileId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [customCommand, setCustomCommand] = useState('');
  const [useCustom, setUseCustom] = useState(false);

  const customArgv = customCommand.trim().split(/\s+/).filter(Boolean);
  const hasCustom = useCustom && customArgv.length > 0;
  /** 没有任何验证命令不再阻止创建 —— 只是终态会变成 ACCEPTED_UNVERIFIED */
  const unverifiedMode = selectedCommands.length === 0 && !hasCustom;

  const disabled = false;
  const canSubmit = goal.trim().length > 0 && modelProfileId.length > 0 && !submitting;

  const submit = async () => {
    setSubmitting(true);
    try {
      const { run } = await call('task.create', {
        projectId: project.projectId,
        snapshotId: snapshot.snapshotId,
        profileId: profile.profileId,
        modelProfileId,
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
        // 空串表示不做交叉审核；选了才传，且必然与 implementer 不同（选项已过滤）
        ...(reviewerProfileId ? { reviewerModelProfileId: reviewerProfileId } : {}),
      });
      onCreated(run);
    } catch (err) {
      onError(err);
    } finally {
      setSubmitting(false);
    }
  };

  if (enabledModels.length === 0) {
    return (
      <Card title="新建任务">
        <Banner tone="warn">
          没有已启用的模型 Profile。请设置 <code>ANTHROPIC_API_KEY</code> / <code>OPENAI_API_KEY</code> /{' '}
          <code>DEEPSEEK_API_KEY</code> 中的任意一个后重启应用。
        </Banner>
      </Card>
    );
  }

  return (
    <Card title="新建任务" hint="TaskSpec">
      <div className="field">
        <label>目标</label>
        <textarea
          value={goal}
          disabled={disabled}
          placeholder="例如：修复 npm run build 失败 —— TypeScript 报 src/App.tsx 里 useCounter 的返回类型不匹配"
          onChange={(e) => setGoal(e.target.value)}
        />
        <div className="help">写清楚"哪个命令失败了、失败长什么样"，比写"修一下 bug"有效得多。</div>
      </div>

      <div className="field">
        <label>任务类型</label>
        <select value={taskClass} disabled={disabled} onChange={(e) => setTaskClass(e.target.value as TaskClass)}>
          {profile.supportedTaskClasses.map((c) => (
            <option key={c} value={c}>
              {TASK_CLASS_LABEL[c]}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label>验证命令（决定能不能说"成功"，可以不选）</label>
        <div>
          {commandIds.map((id) => (
            <button
              key={id}
              type="button"
              className={`chip ${selectedCommands.includes(id) ? 'selected' : ''}`}
              onClick={() =>
                setSelectedCommands((prev) =>
                  prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
                )
              }
            >
              {id} → {profile.commands[id]!.label}
            </button>
          ))}
          <button
            type="button"
            className={`chip ${useCustom ? 'selected' : ''}`}
            onClick={() => setUseCustom((v) => !v)}
          >
            + 自定义命令
          </button>
        </div>
        {useCustom && (
          <input
            style={{ marginTop: 8 }}
            value={customCommand}
            placeholder="例如：pnpm --filter web build（按空格拆成 argv，不经过 shell）"
            onChange={(e) => setCustomCommand(e.target.value)}
          />
        )}
        <div className="help">
          先跑一次基线，再跑修改后的版本。只有基线失败、修改后通过，才算真的修好了。
          检测不出命令的项目可以自己填一条。
        </div>
      </div>

      {unverifiedMode && (
        <Banner tone="warn">
          <strong>未验证模式</strong>：没有选任何验证命令，Agent 照常读代码、出计划、改文件、给补丁，
          但不会跑基线、不会重验、不做自修复。接受补丁后终态是{' '}
          <code>ACCEPTED_UNVERIFIED</code> 而不是 <code>SUCCEEDED</code> —— 正确性完全由你判断。
        </Banner>
      )}

      <div className="field">
        <label>允许修改的路径</label>
        <input value={allowedPaths} disabled={disabled} onChange={(e) => setAllowedPaths(e.target.value)} />
        <div className="help">
          逗号或换行分隔。受保护路径（{profile.protectedPaths.slice(0, 4).join(', ')}…）无论如何都禁止修改。
        </div>
      </div>

      <div className="field">
        <label>验收条件（每行一条，可留空）</label>
        <textarea
          value={acceptance}
          disabled={disabled}
          placeholder={'不引入新的类型错误\n不修改测试文件'}
          onChange={(e) => setAcceptance(e.target.value)}
        />
      </div>

      <div className="field">
        <label>模型路由（本次 Attempt 会冻结这条路由）</label>
        <select value={modelProfileId} disabled={disabled} onChange={(e) => setModelProfileId(e.target.value)}>
          {enabledModels.map((m) => (
            <option key={m.profileId} value={m.profileId}>
              {m.label} · {m.modelId}
            </option>
          ))}
        </select>
        <div className="help">运行中不会自动切换供应商或模型；路由漂移会导致阻断而不是静默换路。</div>
      </div>

      <div className="field">
        <label>交叉审核（可选）：第二个模型只读审补丁</label>
        <select
          value={reviewerProfileId}
          disabled={disabled}
          onChange={(e) => setReviewerProfileId(e.target.value)}
        >
          <option value="">不做交叉审核</option>
          {enabledModels
            .filter((m) => m.profileId !== modelProfileId)
            .map((m) => (
              <option key={m.profileId} value={m.profileId}>
                {m.label} · {m.modelId}
              </option>
            ))}
        </select>
        <div className="help">
          补丁封存后，由另一个模型只读审一遍并给出发现。它的"通过"<b>不等于</b>验证通过，也不代表可以接受
          —— 是否接受仍由你决定。异构（不同供应商）的第二意见价值更高。
        </div>
      </div>

      <div className="row">
        <span className="spacer" />
        <button className="primary" disabled={!canSubmit} onClick={() => void submit()}>
          {submitting ? '创建中…' : '创建并开始'}
        </button>
      </div>
    </Card>
  );
}
