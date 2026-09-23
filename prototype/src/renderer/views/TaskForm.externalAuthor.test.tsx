// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type {
  ModelConnectionProfile,
  ProjectRef,
  RepositoryHarnessProfile,
  RepositorySnapshot,
} from '@shared/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ObserverHandoffArtifact } from '@shared/observerProtocol';

const callMock = vi.fn();
vi.mock('../bridge', () => ({
  call: (...args: unknown[]) => callMock(...args),
  RequestError: class RequestError extends Error {},
}));

import { Composer } from './TaskForm';

/**
 * 外部作者 / 外部 CLI 审核方在任务输入区里的可达性与载荷。
 *
 * 08-17 审计记过：外部 CLI 审核方在 Core 里是可选的，但 Renderer 里
 * `reviewerConnectorId` 零命中 —— UI 不可达。这里把"可达"和"传对字段"钉成断言：
 *   - 连接器来自 crossreview.reviewers（不可用的也显示，带原因，禁用）；
 *   - 选外部作者 → task.create 带 authorConnectorId；
 *   - 选 CLI 审核方 → 带 reviewerConnectorId 而不是 reviewerModelProfileId；
 *   - 作者与审核方撞同一个连接器时，审核选择被清掉（Core 也会拒，UI 先不让撞）。
 */

const project: ProjectRef = {
  projectId: 'project-1',
  name: 'demo',
  displayPath: '~/code/demo',
  createdAt: '2026-08-13T00:00:00.000Z',
};
const snapshot: RepositorySnapshot = {
  snapshotId: 'snapshot-1',
  projectId: 'project-1',
  baseSha: '0123456789abcdef0123456789abcdef01234567',
  branch: 'main',
  baseKind: 'CLEAN_COMMIT',
  dirtyFileCount: 0,
  untrackedCount: 0,
  subPath: '',
  fileCount: 12,
  totalBytes: 4096,
  treeDigest: 'sha256:tree',
  excludedPaths: [],
  createdAt: '2026-08-13T00:00:00.000Z',
};
const profile: RepositoryHarnessProfile = {
  profileId: 'profile-1',
  snapshotId: 'snapshot-1',
  adapterId: 'vite-react-ts',
  adapterVersion: '1.0.0',
  supportStatus: 'VERIFIED',
  detectedSignals: ['vite.config.ts'],
  packageManager: 'pnpm',
  commands: {
    build: {
      commandId: 'build',
      label: '构建',
      argv: ['pnpm', 'build'],
      cwdRelative: '',
      timeoutMs: 60_000,
      risk: 'R1',
      source: 'DETECTED',
    },
  },
  protectedPaths: [],
  supportedTaskClasses: ['BUILD_FIX'],
  notes: [],
};
const model: ModelConnectionProfile = {
  profileId: 'model-1',
  providerId: 'deepseek',
  label: 'DeepSeek',
  kind: 'OFFICIAL',
  builtIn: true,
  wire: 'openai',
  origin: 'https://api.deepseek.com',
  officialOrigin: 'https://api.deepseek.com',
  baseUrlOverride: '',
  isRelay: false,
  modelId: 'deepseek-chat',
  availableModels: ['deepseek-chat'],
  credentialEnvVar: 'DEEPSEEK_API_KEY',
  credentialEnvVars: ['DEEPSEEK_API_KEY'],
  credentialSource: 'APP',
  fallbackSource: 'NONE',
  fallbackEnvVar: null,
  credentialHint: '…abcd',
  docUrl: 'https://example.invalid',
  enabled: true,
  routeSwitchPolicy: 'MANUAL_ONLY',
  automaticFallback: 'DENY',
};

const reviewers = [
  { id: 'model-1', kind: 'MODEL_API', label: 'DeepSeek · deepseek-chat', detail: '', available: true, reason: null },
  { id: 'codex-cli', kind: 'EXTERNAL_CLI', label: 'Codex · 0.1', detail: 'ready', available: true, reason: null },
  {
    id: 'claude-cli',
    kind: 'EXTERNAL_CLI',
    label: 'Claude Code',
    detail: 'no key',
    available: false,
    reason: '缺少 ANTHROPIC_API_KEY',
  },
];

/** 披露由"目的地"决定 digest：加了作者/审核方就变 —— 与 Core 同形的最小替身 */
function disclosureFor(payload: Record<string, unknown>) {
  const withHandoff = (items: string[]) =>
    payload.handoffDigest ? [...items, 'OBSERVED_SESSION_HANDOFF'] : items;
  const destinations = [
    ...(payload.plannerModelProfileId ? [{ role: 'PLANNER', channel: 'MODEL_API', label: 'DeepSeek · deepseek-chat', providerId: 'deepseek', origin: 'https://api.deepseek.com', isRelay: false, modelId: 'deepseek-chat', resolutionDigest: 'sha256:r1', dataClasses: withHandoff(['TASK_TEXT']) }] : []),
    { role: 'IMPLEMENTER', channel: 'MODEL_API', label: 'DeepSeek · deepseek-chat', providerId: 'deepseek', origin: 'https://api.deepseek.com', isRelay: false, modelId: 'deepseek-chat', resolutionDigest: 'sha256:r1', dataClasses: withHandoff(['TASK_TEXT', 'REPOSITORY_SNAPSHOT_EXCERPTS']) },
    ...(payload.reviewerConnectorId ? [{ role: 'REVIEWER', channel: 'EXTERNAL_CLI', label: 'Codex · 0.1（本机 CLI）', providerId: 'openai', origin: null, isRelay: false, modelId: null, resolutionDigest: null, dataClasses: withHandoff(['PATCH_DIFF']) }] : []),
    ...(payload.authorConnectorId ? [{ role: 'AUTHOR', channel: 'EXTERNAL_CLI', label: 'Codex · 0.1（本机 CLI）', providerId: 'openai', origin: null, isRelay: false, modelId: null, resolutionDigest: null, dataClasses: withHandoff(['REPOSITORY_FULL_COPY_VIA_CLI']) }] : []),
  ];
  return {
    disclosureVersion: 3,
    snapshotId: 'snapshot-1',
    snapshotFileCount: 12,
    destinations,
    crossReviewParity: payload.reviewerConnectorId
      ? { kind: 'HETEROGENEOUS', detail: '实现方 deepseek/deepseek-chat 属 DeepSeek，审核方 Codex 属 OpenAI' }
      : null,
    handoffDigest: payload.handoffDigest ?? null,
    policy: { retention: 'UNKNOWN', training: 'UNKNOWN', region: 'UNKNOWN' },
    digest: `sha256:disclosure-${destinations.map((d) => d.role).join('+')}${payload.handoffDigest ? '-handoff' : ''}`,
  };
}

async function consent() {
  const box = (await screen.findByRole('checkbox', { name: /我确认：本任务会把数据发往/ })) as HTMLInputElement;
  if (!box.checked) fireEvent.click(box);
  await waitFor(() => expect((screen.getByRole('button', { name: '开始' }) as HTMLButtonElement).disabled).toBe(false));
}

function composer(onCreated = vi.fn(), handoffDraft: ObserverHandoffArtifact | null = null) {
  return (
    <Composer
      project={project}
      snapshot={snapshot}
      profile={profile}
      modelProfiles={[model]}
      handoffDraft={handoffDraft}
      activeRun={null}
      onCreated={onCreated}
      onReimport={vi.fn()}
      onOpenRun={vi.fn()}
      onOpenSettings={vi.fn()}
      onError={vi.fn()}
    />
  );
}

async function openOptions() {
  fireEvent.click(screen.getByRole('button', { name: /任务选项/ }));
  await waitFor(() => expect(screen.getByRole('button', { name: /Codex · 0\.1$/ })).toBeTruthy());
}

beforeEach(() => {
  callMock.mockReset();
  callMock.mockImplementation(async (method: string, payload: Record<string, unknown>) => {
    if (method === 'crossreview.reviewers') return { reviewers };
    if (method === 'files.tree') {
      return {
        entries: [
          { path: 'src/app.ts', bytes: 10, changed: false },
          { path: 'src/lib/util.ts', bytes: 10, changed: false },
          { path: 'docs/readme.md', bytes: 10, changed: false },
        ],
        source: 'SNAPSHOT',
        generation: null,
      };
    }
    if (method === 'egress.disclosure') return { disclosure: disclosureFor(payload) };
    if (method === 'task.create') return { run: { runId: 'run-1' } };
    throw new Error(`unexpected ${method}`);
  });
});
afterEach(() => cleanup());

describe('外部作者与外部 CLI 审核方：可达且传对字段', () => {
  it('双 Agent 模式把同一 planner/mode 输入用于披露和 task.create', async () => {
    render(composer());
    await openOptions();
    fireEvent.click(screen.getByRole('button', { name: '双 Agent · 逐步交接' }));
    fireEvent.click(screen.getByRole('button', { name: /Codex · 0\.1（CLI）/ }));
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    fireEvent.change(screen.getByPlaceholderText(/描述要修的问题/), { target: { value: '修一下构建' } });
    await waitFor(() => expect(screen.getByTestId('egress-disclosure').textContent).toContain('计划方'));
    await consent();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '开始' })));
    const disclosure = callMock.mock.calls.find((call) => call[0] === 'egress.disclosure' && call[1].collaborationMode);
    const create = callMock.mock.calls.find((call) => call[0] === 'task.create');
    expect(disclosure?.[1]).toMatchObject({ plannerModelProfileId: 'model-1', collaborationMode: 'MANUAL_HANDOFF' });
    expect(create?.[1]).toMatchObject({ plannerModelProfileId: 'model-1', collaborationMode: 'MANUAL_HANDOFF', reviewerConnectorId: 'codex-cli' });
  });

  it('连接器列表来自 crossreview.reviewers；不可用的显示为禁用并带原因', async () => {
    render(composer());
    await openOptions();
    const claude = screen.getByRole('button', { name: /Claude Code（不可用）/ }) as HTMLButtonElement;
    expect(claude.disabled).toBe(true);
    expect(claude.title).toContain('缺少 ANTHROPIC_API_KEY');
    expect(screen.getByText(/不可用的原因：/).textContent).toContain('缺少 ANTHROPIC_API_KEY');
  });

  it('选外部作者 → task.create 带 authorConnectorId；默认不带', async () => {
    render(composer());
    await openOptions();
    fireEvent.click(screen.getByRole('button', { name: /Codex · 0\.1$/ }));
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    fireEvent.change(screen.getByPlaceholderText(/描述要修的问题/), { target: { value: '修一下构建' } });
    // 披露里此时应出现"作者"目的地；同意后才能发
    await waitFor(() => expect(screen.getByTestId('egress-disclosure').textContent).toContain('Codex · 0.1（本机 CLI）'));
    await consent();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '开始' }));
    });
    const create = callMock.mock.calls.find((c) => c[0] === 'task.create');
    expect(create).toBeDefined();
    expect(create![1]).toMatchObject({ authorConnectorId: 'codex-cli', egressConsentDigest: 'sha256:disclosure-IMPLEMENTER+AUTHOR' });
    expect(create![1]).not.toHaveProperty('reviewerConnectorId');
  });

  it('选 CLI 审核方 → 带 reviewerConnectorId 而不是 reviewerModelProfileId', async () => {
    render(composer());
    await openOptions();
    fireEvent.click(screen.getByRole('button', { name: /Codex · 0\.1（CLI）/ }));
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    fireEvent.change(screen.getByPlaceholderText(/描述要修的问题/), { target: { value: '修一下构建' } });
    await consent();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '开始' }));
    });
    const create = callMock.mock.calls.find((c) => c[0] === 'task.create');
    expect(create![1]).toMatchObject({ reviewerConnectorId: 'codex-cli', egressConsentDigest: 'sha256:disclosure-IMPLEMENTER+REVIEWER' });
    expect(create![1]).not.toHaveProperty('reviewerModelProfileId');
    expect(create![1]).not.toHaveProperty('authorConnectorId');
  });

  it('作者与审核方选了同一个连接器 → 审核选择被清掉，且该连接器不再出现在审核候选里', async () => {
    render(composer());
    await openOptions();
    fireEvent.click(screen.getByRole('button', { name: /Codex · 0\.1（CLI）/ }));
    fireEvent.click(screen.getByRole('button', { name: /Codex · 0\.1$/ })); // 再把它选成作者
    expect(screen.queryByRole('button', { name: /Codex · 0\.1（CLI）/ })).toBeNull();
    /*
     * 审核选择确实被清掉了 —— 现在的判据是 off 态 chip 回到选中,
     * 而不是去读一个自由文本框的 value（那个 textarea 已经退役:
     * 取值集合本来就等于这排 chips,自由文本唯一的增量是"多行"和"拼错"
     * 两类必被拒的输入）。
     */
    const offChip = screen.getByRole('button', { name: '不做交叉审核（默认）' });
    expect(offChip.getAttribute('aria-pressed')).toBe('true');
  });

  it('审核方 chip 可以点回来 —— 选了不是就关不掉了', async () => {
    /*
     * 旧控件的实际缺陷：chips 挂了 aria-pressed 宣称自己是开关,却只赋值不切换。
     * 选中之后除了手动去 textarea 里删字,没有任何关闭路径 —— 而 textarea
     * 正是这次要退役的东西。所以 off 态必须先存在,再谈删 textarea。
     */
    render(composer());
    await openOptions();
    const off = () => screen.getByRole('button', { name: '不做交叉审核（默认）' });
    expect(off().getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: /Codex · 0\.1（CLI）/ }));
    expect(off().getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(off());
    expect(off().getAttribute('aria-pressed')).toBe('true');
    expect(
      screen.getByRole('button', { name: /Codex · 0\.1（CLI）/ }).getAttribute('aria-pressed'),
    ).toBe('false');
  });
});

describe('出站披露与同意：不点头不能发；目的地一变同意作废', () => {
  it('观察交接预填审核目标，单独列入披露，并把冻结正文与 digest 一起提交', async () => {
    const handoff: ObserverHandoffArtifact = {
      handoffId: 'handoff_1',
      sessionId: 'CLAUDE_JOURNAL:one.jsonl',
      projectDisplayPath: project.displayPath,
      vendor: 'CLAUDE_JOURNAL',
      source: 'DESKTOP_LOCAL_AGENT',
      sourceEvidence: ['entrypoint=claude-desktop'],
      completion: { state: 'READY_TO_HANDOFF', evidence: ['message.stop_reason=end_turn'] },
      sourceUpdatedAt: '2026-09-14T00:00:00.000Z',
      preparedAt: '2026-09-14T00:00:01.000Z',
      payload: '来源：Claude Desktop\nassistant：已完成',
      digest: 'sha256:handoff',
      includedLines: 1,
      omittedLines: 0,
      suggestedGoal: '审核 Claude Desktop 的本地工作结果',
    };
    render(composer(vi.fn(), handoff));
    expect((screen.getByPlaceholderText(/描述要修的问题/) as HTMLTextAreaElement).value).toBe(handoff.suggestedGoal);
    expect(await screen.findByText(/用户确认交接的本机会话内容/)).toBeTruthy();
    await consent();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '开始' })));
    const create = callMock.mock.calls.find((c) => c[0] === 'task.create');
    expect(create?.[1]).toMatchObject({
      handoffPayload: handoff.payload,
      handoffDigest: handoff.digest,
      egressConsentDigest: 'sha256:disclosure-IMPLEMENTER-handoff',
    });
  });

  it('填了目标但没勾同意 → 开始按钮禁用；勾了才能发；载荷带 egressConsentDigest', async () => {
    render(composer());
    // 目标为空时：按钮旁的原因提示指向"写目标"，不是让用户自己猜
    expect(screen.getByText('先写下要修什么')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText(/描述要修的问题/), { target: { value: '修一下构建' } });
    await screen.findByRole('checkbox', { name: /我确认：本任务会把数据发往/ });
    expect((screen.getByRole('button', { name: '开始' }) as HTMLButtonElement).disabled).toBe(true);
    // 目标有了、同意还没勾：原因跟着切换到披露
    expect(screen.getByText('先确认上方的数据出站披露')).toBeTruthy();
    const block = screen.getByTestId('egress-disclosure');
    expect(block.textContent).toContain('DeepSeek · deepseek-chat');
    expect(block.textContent).toContain('官方 · https://api.deepseek.com');
    expect(block.textContent).toContain('保留/训练/地域政策：未知');
    await consent();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '开始' }));
    });
    const create = callMock.mock.calls.find((c) => c[0] === 'task.create');
    expect(create![1]).toMatchObject({ egressConsentDigest: 'sha256:disclosure-IMPLEMENTER' });
  });

  it('同意后再选外部作者 → 披露 digest 变化，同意自动作废，按钮重新禁用', async () => {
    render(composer());
    fireEvent.change(screen.getByPlaceholderText(/描述要修的问题/), { target: { value: '修一下构建' } });
    await consent();
    await openOptions();
    fireEvent.click(screen.getByRole('button', { name: /Codex · 0\.1$/ }));
    await waitFor(() => expect(screen.getByTestId('egress-disclosure').textContent).toContain('Codex · 0.1（本机 CLI）'));
    const box = screen.getByRole('checkbox', { name: /我确认：本任务会把数据发往/ }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    // 作废不静默：必须说清"你确认的是旧披露"，而不是让勾选凭空消失
    expect(screen.getByText(/披露内容已变化/).textContent).toContain('针对的是旧披露');
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect((screen.getByRole('button', { name: '开始' }) as HTMLButtonElement).disabled).toBe(true);
    // 重新勾选 → 解释消失、按钮恢复
    fireEvent.click(box);
    await waitFor(() => expect((screen.getByRole('button', { name: '开始' }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByText(/披露内容已变化/)).toBeNull();
  });

  it('披露取不到 → 显示原因且不能发（fail-closed）', async () => {
    callMock.mockImplementation(async (method: string) => {
      if (method === 'crossreview.reviewers') return { reviewers };
      if (method === 'egress.disclosure') throw new Error('Core 不可用');
      throw new Error(`unexpected ${method}`);
    });
    render(composer());
    fireEvent.change(screen.getByPlaceholderText(/描述要修的问题/), { target: { value: '修一下构建' } });
    // 页面上可以有多个 status 区（披露错误 + 开始按钮旁的原因提示），按内容找目标那条
    await waitFor(() =>
      expect(screen.getAllByRole('status').map((n) => n.textContent).join('\n')).toContain(
        '无法取得出站披露：Core 不可用',
      ),
    );
    expect(screen.queryByRole('checkbox', { name: /我确认/ })).toBeNull();
    expect((screen.getByRole('button', { name: '开始' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('允许修改的路径：事前报命中数，但不拦提交', () => {
  it('0 命中要当场说出来 —— 不该等模型改到一半被整笔拒才知道', async () => {
    render(composer());
    await openOptions();

    const input = screen.getByPlaceholderText(/留空 = 整个仓库都可改/);
    fireEvent.change(input, { target: { value: 'lib/**' } });

    // 快照里只有 src/** 与 docs/**，lib/** 一个都不匹配
    expect(await screen.findByText(/匹配这份快照里的 0 个文件/)).toBeTruthy();
  });

  it('命中数用的是 Core 门禁那同一份 globMatch —— `*` 不跨目录', async () => {
    /*
     * 这条是这个提示存在的前提：界面若另写一份规则，会出现"提示说匹配上了、
     * 跑起来却 PATH_NOT_ALLOWED"。所以刻意挑一个能区分两种实现的用例 ——
     * `src/*` 只匹配 src 下一级（src/app.ts），不匹配 src/lib/util.ts。
     */
    render(composer());
    await openOptions();

    const input = screen.getByPlaceholderText(/留空 = 整个仓库都可改/);
    fireEvent.change(input, { target: { value: 'src/*' } });
    expect(await screen.findByText(/匹配 1 个文件/)).toBeTruthy();

    // 对照：src/** 跨目录，两个都算
    fireEvent.change(input, { target: { value: 'src/**' } });
    expect(await screen.findByText(/匹配 2 个文件/)).toBeTruthy();
  });

  it('填了匹配不到的路径仍然可以提交 —— 这是提示，不是门禁', async () => {
    render(composer());
    await openOptions();
    fireEvent.change(screen.getByPlaceholderText(/留空 = 整个仓库都可改/), {
      target: { value: 'lib/**' },
    });
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    fireEvent.change(screen.getByPlaceholderText(/描述要修的问题/), { target: { value: '修一下构建' } });
    await consent();

    /*
     * 任务选项的既定原则是"锦上添花，不设置就必须不干扰" —— 那也意味着
     * 填得不好不该拦人：用户可能故意写一条为将来准备的路径。
     */
    expect((screen.getByRole('button', { name: '开始' }) as HTMLButtonElement).disabled).toBe(false);
  });
});
