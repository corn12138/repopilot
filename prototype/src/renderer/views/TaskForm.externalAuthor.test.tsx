// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type {
  ModelConnectionProfile,
  ProjectRef,
  RepositoryHarnessProfile,
  RepositorySnapshot,
} from '@shared/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  const destinations = [
    { role: 'IMPLEMENTER', channel: 'MODEL_API', label: 'DeepSeek · deepseek-chat', providerId: 'deepseek', origin: 'https://api.deepseek.com', isRelay: false, modelId: 'deepseek-chat', resolutionDigest: 'sha256:r1', dataClasses: ['TASK_TEXT', 'REPOSITORY_SNAPSHOT_EXCERPTS'] },
    ...(payload.reviewerConnectorId ? [{ role: 'REVIEWER', channel: 'EXTERNAL_CLI', label: 'Codex · 0.1（本机 CLI）', providerId: 'openai', origin: null, isRelay: false, modelId: null, resolutionDigest: null, dataClasses: ['PATCH_DIFF'] }] : []),
    ...(payload.authorConnectorId ? [{ role: 'AUTHOR', channel: 'EXTERNAL_CLI', label: 'Codex · 0.1（本机 CLI）', providerId: 'openai', origin: null, isRelay: false, modelId: null, resolutionDigest: null, dataClasses: ['REPOSITORY_FULL_COPY_VIA_CLI'] }] : []),
  ];
  return {
    disclosureVersion: 2,
    snapshotId: 'snapshot-1',
    snapshotFileCount: 12,
    destinations,
    crossReviewParity: payload.reviewerConnectorId
      ? { kind: 'HETEROGENEOUS', detail: '实现方 deepseek/deepseek-chat 属 DeepSeek，审核方 Codex 属 OpenAI' }
      : null,
    policy: { retention: 'UNKNOWN', training: 'UNKNOWN', region: 'UNKNOWN' },
    digest: `sha256:disclosure-${destinations.map((d) => d.role).join('+')}`,
  };
}

async function consent() {
  const box = (await screen.findByRole('checkbox', { name: /我确认：本任务会把数据发往/ })) as HTMLInputElement;
  if (!box.checked) fireEvent.click(box);
  await waitFor(() => expect((screen.getByRole('button', { name: '开始' }) as HTMLButtonElement).disabled).toBe(false));
}

function composer(onCreated = vi.fn()) {
  return (
    <Composer
      project={project}
      snapshot={snapshot}
      profile={profile}
      modelProfiles={[model]}
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
    if (method === 'egress.disclosure') return { disclosure: disclosureFor(payload) };
    if (method === 'task.create') return { run: { runId: 'run-1' } };
    throw new Error(`unexpected ${method}`);
  });
});
afterEach(() => cleanup());

describe('外部作者与外部 CLI 审核方：可达且传对字段', () => {
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
    const reviewerBox = screen.getAllByRole('textbox').find((t) => (t as HTMLTextAreaElement).placeholder.includes('审核方'));
    expect((reviewerBox as HTMLTextAreaElement).value).toBe('');
  });
});

describe('出站披露与同意：不点头不能发；目的地一变同意作废', () => {
  it('填了目标但没勾同意 → 开始按钮禁用；勾了才能发；载荷带 egressConsentDigest', async () => {
    render(composer());
    fireEvent.change(screen.getByPlaceholderText(/描述要修的问题/), { target: { value: '修一下构建' } });
    await screen.findByRole('checkbox', { name: /我确认：本任务会把数据发往/ });
    expect((screen.getByRole('button', { name: '开始' }) as HTMLButtonElement).disabled).toBe(true);
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
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect((screen.getByRole('button', { name: '开始' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('披露取不到 → 显示原因且不能发（fail-closed）', async () => {
    callMock.mockImplementation(async (method: string) => {
      if (method === 'crossreview.reviewers') return { reviewers };
      if (method === 'egress.disclosure') throw new Error('Core 不可用');
      throw new Error(`unexpected ${method}`);
    });
    render(composer());
    fireEvent.change(screen.getByPlaceholderText(/描述要修的问题/), { target: { value: '修一下构建' } });
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('无法取得出站披露：Core 不可用'));
    expect(screen.queryByRole('checkbox', { name: /我确认/ })).toBeNull();
    expect((screen.getByRole('button', { name: '开始' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
