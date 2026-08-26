// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  EMPTY_LEDGER,
  type CrossReviewRecord,
  type PatchArtifact,
  type RunStatus,
  type RunView,
} from '@shared/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalActionController } from '../useApprovalAction';
import { RunDetail } from './RunDetail';

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }));

vi.mock('../bridge', () => ({ call: requestMock }));

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

/** 请求顺序是测试合同：新 owner 可见后，旧实体请求才被允许完成。 */
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function makeRun(runId: string, status: RunStatus = 'SUCCEEDED'): RunView {
  return {
    runId,
    taskId: `task-${runId}`,
    projectId: 'project-1',
    snapshotId: 'snapshot-1',
    title: `Run ${runId}`,
    attemptId: `attempt-${runId}`,
    attemptNo: 1,
    status,
    statusReason: null,
    ledger: { ...EMPTY_LEDGER },
    limits: {
      maxModelTurns: 10,
      maxToolCalls: 20,
      maxSelfFixRounds: 2,
      maxWallClockMs: 60_000,
      maxTotalTokens: 10_000,
    },
    workspaceGeneration: 1,
    createdAt: '2026-08-13T00:00:00.000Z',
    updatedAt: '2026-08-13T00:00:01.000Z',
    terminalFacts:
      status === 'SUCCEEDED'
        ? { verificationRunId: `verification-${runId}`, patchAcceptanceId: `accept-${runId}` }
        : null,
    restored: false,
    evidence: 'INTACT',
    evidenceDetail: null,
  };
}

function makePatch(patchId: string, runId: string): PatchArtifact {
  return {
    patchId,
    runId,
    attemptId: `attempt-${runId}`,
    baseSha: '0123456789abcdef0123456789abcdef01234567',
    generation: 1,
    files: [
      {
        path: `${patchId}.ts`,
        changeKind: 'MODIFIED',
        addedLines: 1,
        removedLines: 1,
        diff: `--- a/${patchId}.ts\n+++ b/${patchId}.ts\n-old\n+new`,
        diffTruncated: false,
      },
    ],
    unifiedDiff: '',
    digest: `sha256:${patchId}`,
    sealedAt: '2026-08-13T00:00:01.000Z',
    verificationRunId: `verification-${runId}`,
    comparison: { fixed: ['typecheck'], stillFailing: [], newlyFailing: [], notRerun: [] },
    unverifiedItems: [],
    excludedGeneratedFiles: [],
  };
}

function makeCrossReview(): CrossReviewRecord {
  return {
    enabled: true,
    reviewerProfileId: 'reviewer-a',
    heterogeneous: true,
    rounds: [],
    reviewerInvocations: 1,
    remediations: 0,
    stopReason: 'ERROR',
    startedAt: '2026-08-13T00:00:00.000Z',
    finishedAt: '2026-08-13T00:00:01.000Z',
  };
}

function detail(run: RunView, patch: PatchArtifact | null = null) {
  const approvalAction = {
    ownerRunId: run.runId,
    pending: [],
    error: null,
    isPending: () => false,
    decide: vi.fn(async () => false),
    retry: vi.fn(async () => false),
    clearError: vi.fn(),
  } satisfies ApprovalActionController;
  return (
    <RunDetail
      run={run}
      events={[]}
      toolCalls={[]}
      approvals={[]}
      plan={null}
      patch={patch}
      verifications={[]}
      approvalAction={approvalAction}
      onError={vi.fn()}
      onRefresh={vi.fn()}
    />
  );
}

describe('RunDetail entity-owned local state', () => {
  beforeEach(() => {
    requestMock.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('drops Run A cross-review after switching to B and exposes B read failure', async () => {
    const reviewA = deferred<{ crossReview: CrossReviewRecord | null }>();
    const reviewB = deferred<{ crossReview: CrossReviewRecord | null }>();
    const reviewC = deferred<{ crossReview: CrossReviewRecord | null }>();
    requestMock.mockImplementation((method: string, payload: { runId: string }) => {
      if (method !== 'crossreview.get') throw new Error(`unexpected ${method}`);
      if (payload.runId === 'run-a') return reviewA.promise;
      if (payload.runId === 'run-b') return reviewB.promise;
      return reviewC.promise;
    });

    const view = render(detail(makeRun('run-a')));
    view.rerender(detail(makeRun('run-b')));
    await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(2));

    await act(async () => reviewB.resolve({ crossReview: null }));
    await act(async () => reviewA.resolve({ crossReview: makeCrossReview() }));
    expect(screen.queryByText('审核过程出错')).toBeNull();

    view.rerender(detail(makeRun('run-c')));
    await act(async () => reviewC.reject(new Error('review storage unavailable')));
    expect(screen.getByText(/交叉审核记录读取失败：review storage unavailable/)).toBeTruthy();
  });

  it('returns patch B to the first apply-confirmation step', async () => {
    requestMock.mockResolvedValue({ crossReview: null });
    const run = makeRun('run-1');
    const view = render(detail(run, makePatch('patch-a', run.runId)));

    fireEvent.click(screen.getByRole('button', { name: '应用到仓库…' }));
    expect(screen.getByRole('button', { name: '确认写入仓库' })).toBeTruthy();
    expect(screen.getByText('真的修改你的仓库文件')).toBeTruthy();

    view.rerender(detail(run, makePatch('patch-b', run.runId)));
    expect(screen.getByRole('button', { name: '应用到仓库…' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '确认写入仓库' })).toBeNull();
    expect(screen.queryByText('真的修改你的仓库文件')).toBeNull();
  });
});

describe('RunDetail 取消动作的就地反馈', () => {
  beforeEach(() => {
    requestMock.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('请求在途时按钮显示 busy 且不接受第二次点击', async () => {
    const cancelCall = deferred<unknown>();
    requestMock.mockImplementation((method: string) => {
      if (method === 'crossreview.get') return Promise.resolve({ crossReview: null });
      if (method === 'run.cancel') return cancelCall.promise;
      throw new Error(`unexpected ${method}`);
    });

    render(detail(makeRun('run-1', 'EXECUTING')));
    fireEvent.click(screen.getByRole('button', { name: '取消' }));

    const busy = await screen.findByRole('button', { name: '取消中…' });
    expect(busy.hasAttribute('disabled')).toBe(true);
    expect(busy.getAttribute('aria-busy')).toBe('true');

    fireEvent.click(busy);
    expect(requestMock.mock.calls.filter((c) => c[0] === 'run.cancel').length).toBe(1);

    await act(async () => cancelCall.resolve({}));
    expect(screen.getByRole('button', { name: '取消' })).toBeTruthy();
  });

  it('取消失败时在触发位置显示原因，并可原位重试', async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    let cancels = 0;
    requestMock.mockImplementation((method: string) => {
      if (method === 'crossreview.get') return Promise.resolve({ crossReview: null });
      if (method !== 'run.cancel') throw new Error(`unexpected ${method}`);
      cancels += 1;
      return cancels === 1 ? first.promise : second.promise;
    });

    render(detail(makeRun('run-1', 'EXECUTING')));
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    await act(async () => first.reject(new Error('执行器已经不在了')));

    // 顶部通用错误条不是唯一反馈：失败必须留在按下按钮的那张卡片里。
    expect(screen.getByRole('alert').textContent).toContain('取消失败：执行器已经不在了');

    fireEvent.click(screen.getByRole('button', { name: '重试取消' }));
    expect(cancels).toBe(2);

    await act(async () => second.resolve({}));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('「收起」只清掉本地提示，不重发请求', async () => {
    const first = deferred<unknown>();
    requestMock.mockImplementation((method: string) => {
      if (method === 'crossreview.get') return Promise.resolve({ crossReview: null });
      if (method === 'run.cancel') return first.promise;
      throw new Error(`unexpected ${method}`);
    });

    render(detail(makeRun('run-1', 'EXECUTING')));
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    await act(async () => first.reject(new Error('执行器已经不在了')));

    fireEvent.click(screen.getByRole('button', { name: '收起' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(requestMock.mock.calls.filter((c) => c[0] === 'run.cancel').length).toBe(1);
  });
});

describe('Slice G：补丁动了验证输入时，"已修复"徽章旁必须有说明', () => {
  beforeEach(() => {
    requestMock.mockReset();
    requestMock.mockImplementation(async () => ({ crossReview: null }));
  });
  afterEach(() => cleanup());

  it('verificationInputsTouched 非空 → 紧挨验证徽章出现 COVERAGE 横幅，点名文件并说明终态是 ACCEPTED_UNVERIFIED', async () => {
    const patch: PatchArtifact = {
      ...makePatch('p-cov', 'run-cov'),
      verificationInputsTouched: ['vitest.config.ts', 'src/a.test.ts'],
      unverifiedItems: ['⚠ COVERAGE_WEAKENED：补丁修改了验证输入 vitest.config.ts, src/a.test.ts（配置 / 测试 / 验证脚本）—— …'],
    };
    render(detail(makeRun('run-cov', 'AWAITING_PATCH_REVIEW'), patch));
    await waitFor(() => expect(screen.getByText(/补丁修改了验证输入：/)).toBeTruthy());
    const banner = screen.getByText(/补丁修改了验证输入：/).closest('div')!;
    expect(banner.textContent).toContain('vitest.config.ts、src/a.test.ts');
    expect(banner.textContent).toContain('ACCEPTED_UNVERIFIED');
    expect(banner.textContent).toContain('不能证明修复正确');
    // 徽章照常显示"已修复"—— 事实不隐藏，只是旁边说清楚它证明不了什么
    expect(screen.getByText(/已修复 typecheck/)).toBeTruthy();
  });

  it('没动验证输入（字段为空或旧快照缺字段）→ 不出现该横幅', async () => {
    const { rerender } = render(detail(makeRun('run-ok', 'AWAITING_PATCH_REVIEW'), { ...makePatch('p-ok', 'run-ok'), verificationInputsTouched: [] }));
    await waitFor(() => expect(screen.getByText(/已修复 typecheck/)).toBeTruthy());
    expect(screen.queryByText(/补丁修改了验证输入：/)).toBeNull();
    rerender(detail(makeRun('run-old', 'AWAITING_PATCH_REVIEW'), makePatch('p-old', 'run-old'))); // 无字段
    expect(screen.queryByText(/补丁修改了验证输入：/)).toBeNull();
  });
});

describe('Slice G：批准计划时必须看得见"能写到哪"', () => {
  beforeEach(() => {
    requestMock.mockReset();
    requestMock.mockImplementation(async () => ({ crossReview: null }));
  });
  afterEach(() => cleanup());

  it('审批卡显示 Core 附在 detail 里的允许范围 / 受保护路径 / 实现方，而不只有摘要', async () => {
    const run = makeRun('run-appr', 'AWAITING_PLAN_APPROVAL');
    const plan = {
      planId: 'plan-1',
      runId: run.runId,
      revision: 1,
      parentPlanId: null,
      summary: '把 STATUS 改成 fixed',
      steps: [{ index: 1, intent: '改 src/app.js', targetPaths: ['src/app.js'], expectedEffect: '' }],
      risks: [],
      digest: 'sha256:plan',
      createdAt: '2026-08-19T00:00:00.000Z',
    };
    const approval = {
      approvalId: 'appr-1',
      runId: run.runId,
      attemptId: run.attemptId,
      kind: 'PLAN' as const,
      risk: 'R1' as const,
      title: '批准执行计划',
      detail:
        '把 STATUS 改成 fixed\n允许改动范围：整个仓库（未限定路径；仅受保护路径除外）；受保护路径：package.json, .github/**\n实现方：外部 CLI Codex 0.1（只在一次性副本里改，差异归一化后进主线）',
      subjectDigest: 'sha256:plan',
      requestedAt: '2026-08-19T00:00:00.000Z',
      expiresAt: '2026-08-19T00:30:00.000Z',
    };
    const approvalAction = {
      ownerRunId: run.runId,
      pending: [],
      error: null,
      isPending: () => false,
      decide: vi.fn(async () => false),
      retry: vi.fn(async () => false),
      clearError: vi.fn(),
    } satisfies ApprovalActionController;
    render(
      <RunDetail
        run={run}
        events={[]}
        toolCalls={[]}
        approvals={[approval]}
        plan={plan as never}
        patch={null}
        verifications={[]}
        approvalAction={approvalAction}
        onError={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );
    const scope = await screen.findByTestId('approval-scope');
    expect(scope.textContent).toContain('整个仓库（未限定路径');
    expect(scope.textContent).toContain('受保护路径：package.json, .github/**');
    expect(scope.textContent).toContain('实现方：外部 CLI Codex 0.1');
    // 摘要本身不会重复出现在范围块里
    expect(scope.textContent).not.toContain('把 STATUS 改成 fixed');
  });
});

describe('数据出站面板：发出去的与被拦下的并列，同意摘要可见', () => {
  beforeEach(() => {
    requestMock.mockReset();
    requestMock.mockImplementation(async () => ({ crossReview: null }));
  });
  afterEach(() => cleanup());

  it('从事件投影：RUN_CREATED 的同意摘要 + 每次模型/CLI 出站一行；NOT_SENT 带阻断原因；token 未知不填 0', async () => {
    const run = makeRun('run-egress', 'AWAITING_PATCH_REVIEW');
    const base = { runId: run.runId, attemptId: run.attemptId, at: '2026-08-19T00:00:00.000Z' };
    const events = [
      {
        ...base,
        seq: 1,
        kind: 'RUN_CREATED' as const,
        summary: '任务已创建',
        payload: {
          egressConsent: {
            disclosureDigest: 'sha256:abcdef0123456789abcdef',
            destinations: [
              { role: 'IMPLEMENTER', channel: 'MODEL_API', label: 'DeepSeek · deepseek-chat', origin: 'https://api.deepseek.com/v1', isRelay: false, dataClasses: ['TASK_TEXT', 'COMMAND_OUTPUT'] },
              { role: 'AUTHOR', channel: 'EXTERNAL_CLI', label: 'Codex（本机 CLI）', origin: null, isRelay: false, dataClasses: ['REPOSITORY_FULL_COPY_VIA_CLI'] },
            ],
            policy: { retention: 'UNKNOWN', training: 'UNKNOWN', region: 'UNKNOWN' },
          },
        },
      },
      {
        ...base,
        seq: 2,
        kind: 'MODEL_INVOCATION' as const,
        summary: 'PLANNING 调用',
        payload: { manifest: { purpose: 'PLANNING', providerId: 'deepseek', modelId: 'deepseek-chat', origin: 'https://api.deepseek.com/v1', sent: true, blockReason: null, inputTokens: 120, outputTokens: 45, errorKind: null } },
      },
      {
        ...base,
        seq: 3,
        kind: 'MODEL_INVOCATION' as const,
        summary: '模型出站被阻断',
        payload: { manifest: { purpose: 'EXECUTION', providerId: 'deepseek', modelId: 'deepseek-chat', origin: 'https://api.deepseek.com/v1', sent: false, blockReason: 'DLP: AWS_ACCESS_KEY_ID @ message[2]', inputTokens: null, outputTokens: null, errorKind: null } },
      },
      {
        ...base,
        seq: 4,
        kind: 'MODEL_INVOCATION' as const,
        summary: 'SELF_FIX 调用',
        payload: { manifest: { purpose: 'SELF_FIX', providerId: 'deepseek', modelId: 'deepseek-chat', origin: 'https://api.deepseek.com/v1', sent: true, blockReason: null, inputTokens: null, outputTokens: null, errorKind: null } },
      },
      {
        ...base,
        seq: 5,
        kind: 'MODEL_INVOCATION' as const,
        summary: 'IMPLEMENT 调用外部 CLI 作者',
        payload: { externalInvocation: { role: 'CANDIDATE_AUTHOR', phase: 'IMPLEMENT', connectorId: 'codex-cli', vendor: 'OPENAI', state: 'SEALED', changedCount: 2, failureDetail: null } },
      },
    ];
    render(
      <RunDetail
        run={run}
        events={events as never}
        toolCalls={[]}
        approvals={[]}
        plan={null}
        patch={null}
        verifications={[]}
        approvalAction={{ ownerRunId: run.runId, pending: [], error: null, isPending: () => false, decide: vi.fn(async () => false), retry: vi.fn(async () => false), clearError: vi.fn() } satisfies ApprovalActionController}
        onError={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );
    const consent = await screen.findByTestId('egress-consent');
    expect(consent.textContent).toContain('sha256:abcdef012');
    expect(consent.textContent).toContain('实现方 DeepSeek · deepseek-chat（官方 · https://api.deepseek.com/v1）');
    expect(consent.textContent).toContain('作者 Codex（本机 CLI）（本机 CLI 自行出站）');
    expect(consent.textContent).toContain('未知');

    const rows = screen.getByTestId('egress-rows');
    const lines = Array.from(rows.querySelectorAll('.egress-row'));
    expect(lines).toHaveLength(4);
    expect(lines[0]!.textContent).toContain('已发送');
    expect(lines[0]!.textContent).toContain('in=120 out=45');
    expect(lines[1]!.getAttribute('data-sent')).toBe('no');
    expect(lines[1]!.textContent).toContain('出站前阻断：DLP: AWS_ACCESS_KEY_ID');
    expect(lines[2]!.textContent).toContain('token 未知（供应商未回报）');
    expect(lines[2]!.textContent).not.toContain('in=0');
    expect(lines[3]!.textContent).toContain('作者 IMPLEMENT · 本机 CLI');
    expect(lines[3]!.textContent).toContain('2 处变更');
    // 卡片标题给出计数：3 次发出（2 模型 + 1 CLI）· 1 次未发出
    expect(screen.getByText(/3 次已发出 · 1 次未发出/)).toBeTruthy();
  });
});

describe('REQUEST_CHANGES 的界面：历史补丁看得见，恢复态开不了新尝试', () => {
  beforeEach(() => {
    requestMock.mockReset();
    requestMock.mockImplementation(async () => ({ crossReview: null }));
  });
  afterEach(() => cleanup());

  function detailWith(run: RunView, patch: PatchArtifact | null, priorPatches: PatchArtifact[]) {
    return (
      <RunDetail
        run={run}
        events={[]}
        toolCalls={[]}
        approvals={[]}
        plan={null}
        patch={patch}
        priorPatches={priorPatches}
        verifications={[]}
        approvalAction={{
          ownerRunId: run.runId,
          pending: [],
          error: null,
          isPending: () => false,
          decide: vi.fn(async () => false),
          retry: vi.fn(async () => false),
          clearError: vi.fn(),
        } satisfies ApprovalActionController}
        onError={vi.fn()}
        onRefresh={vi.fn()}
      />
    );
  }

  it('被要求修改的历史补丁默认折叠但可展开，diff 正文还在', async () => {
    const prior: PatchArtifact = {
      ...makePatch('p-old', 'run-h'),
      files: [
        {
          path: 'src/app.js',
          changeKind: 'MODIFIED',
          addedLines: 1,
          removedLines: 1,
          diff: '--- a/src/app.js\n+++ b/src/app.js\n-old\n+v1 先凑合',
          diffTruncated: false,
        },
      ],
    };
    render(detailWith(makeRun('run-h', 'PLANNING'), null, [prior]));
    expect(await screen.findByText(/1 版被要求修改/)).toBeTruthy();
    const item = screen.getByTestId('prior-patch');
    expect(item.textContent).toContain('第 1 版');
    // 正文在 details 里：内容存在（默认折叠只是不展示）
    expect(item.textContent).toContain('v1 先凑合');
  });

  it('没有历史补丁时不出现这张卡（不给空壳）', async () => {
    render(detailWith(makeRun('run-h2', 'AWAITING_PATCH_REVIEW'), makePatch('p-cur', 'run-h2'), []));
    await screen.findByText(/已修复 typecheck/);
    expect(screen.queryByText(/版被要求修改/)).toBeNull();
  });

  it('恢复态的 Run：接受/拒绝可用，"要求修改"禁用并说明原因', async () => {
    const run = { ...makeRun('run-r', 'AWAITING_PATCH_REVIEW'), restored: true };
    render(detailWith(run, makePatch('p-r', 'run-r'), []));
    const request = (await screen.findByRole('button', { name: '要求修改' })) as HTMLButtonElement;
    expect(request.disabled).toBe(true);
    expect(request.title).toContain('没有活的执行器');
    expect((screen.getByRole('button', { name: '接受补丁' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: '拒绝' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('非恢复态：三个按钮都可用，且"要求修改"说明预算是共用的', async () => {
    render(detailWith(makeRun('run-n', 'AWAITING_PATCH_REVIEW'), makePatch('p-n', 'run-n'), []));
    const request = (await screen.findByRole('button', { name: '要求修改' })) as HTMLButtonElement;
    expect(request.disabled).toBe(false);
    expect(request.title).toContain('预算与本次共用');
  });
});

describe('详情页降噪（交互评审 v0.2 N2/N3/N4）：每个事实只有一个主场', () => {
  beforeEach(() => {
    requestMock.mockReset();
    requestMock.mockImplementation(async () => ({ crossReview: null }));
  });
  afterEach(() => cleanup());

  function renderDetail(run: RunView, events: unknown[] = []) {
    return render(
      <RunDetail
        run={run}
        events={events as never}
        toolCalls={[]}
        approvals={[]}
        plan={null}
        patch={null}
        priorPatches={[]}
        verifications={[]}
        approvalAction={{
          ownerRunId: run.runId,
          pending: [],
          error: null,
          isPending: () => false,
          decide: vi.fn(async () => false),
          retry: vi.fn(async () => false),
          clearError: vi.fn(),
        } satisfies ApprovalActionController}
        onError={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );
  }

  it('运行卡不再重复状态徽章与 m/n 计量（它们的主场是顶栏与用量面板），gen 收进 hint', () => {
    renderDetail(makeRun('run-quiet', 'FAILED'));
    expect(screen.queryByText(/模型轮次/)).toBeNull();
    expect(screen.queryByText(/自修复/)).toBeNull();
    expect(screen.queryByText('失败')).toBeNull(); // 状态徽章在 ChatHead，不在卡上
    expect(screen.getByText('run-quiet · gen-1')).toBeTruthy();
  });

  it('恢复 Run 的"落后一拍"不再是黄色横幅：并入恢复说明，seq 细节保留', () => {
    renderDetail({
      ...makeRun('run-rest', 'FAILED'),
      restored: true,
      evidence: 'EVENTS_AHEAD',
      evidenceDetail: '事件流已到 seq 94，状态快照停在 seq 93',
    });
    expect(screen.queryByText('状态快照落后于事件流。')).toBeNull();
    expect(screen.getByText(/以时间线为准/)).toBeTruthy();
    expect(screen.getByText(/seq 94/)).toBeTruthy(); // 报数不删，只降层级
  });

  it('未恢复（可能还活着）的 EVENTS_AHEAD 仍然黄色横幅告警', () => {
    renderDetail({ ...makeRun('run-live', 'EXECUTING'), evidence: 'EVENTS_AHEAD' });
    expect(screen.getByText('状态快照落后于事件流。')).toBeTruthy();
  });

  it('0 笔出站且无同意记录：不成卡，一行报数说清', () => {
    renderDetail(makeRun('run-empty', 'FAILED'));
    expect(screen.queryByText('数据出站')).toBeNull(); // 卡片标题不在
    expect(screen.getByText(/数据出站 · 0 次/)).toBeTruthy(); // 报数仍在
  });

  it('有出站时：报数在卡片头常驻，逐笔明细默认收在「出站同意与逐笔明细」里', () => {
    const run = makeRun('run-rows', 'FAILED');
    renderDetail(run, [
      {
        runId: run.runId,
        attemptId: run.attemptId,
        at: '2026-08-19T00:00:00.000Z',
        seq: 1,
        kind: 'MODEL_INVOCATION',
        summary: 'PLANNING 调用',
        payload: {
          manifest: {
            purpose: 'PLANNING',
            providerId: 'deepseek',
            modelId: 'deepseek-chat',
            origin: 'https://api.deepseek.com/v1',
            sent: true,
            blockReason: null,
            inputTokens: 120,
            outputTokens: 45,
            errorKind: null,
          },
        },
      },
    ]);
    expect(screen.getByText(/1 次已发出 · 0 次未发出/)).toBeTruthy();
    const fold = screen.getByText('出站同意与逐笔明细').closest('details')!;
    expect(fold.open).toBe(false);
    expect(screen.getByTestId('egress-rows')).toBeTruthy(); // 明细仍在 DOM，不删事实
  });
});
