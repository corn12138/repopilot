// @vitest-environment jsdom

/**
 * 交互评审 v0.2 N9：历史的删除走保留策略，缺的是列表层的出口。
 * 钉住：历史折叠里有"清理历史记录"入口，点击后打开设置页（数据保留卡所在），
 * 且该入口只在折叠区里出现 —— 进行中/最近的 Run 行不带它。
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectRef, RunView } from '@shared/domain';
import type { IpcResult, RepoPilotBridge, RequestMethod } from '@shared/protocol';
import { PROTOCOL_VERSION } from '@shared/protocol';
import { App } from './App';

const NOW = '2026-08-26T00:00:00.000Z';

function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data };
}

function project(id: string, name: string): ProjectRef {
  return { projectId: id, name, displayPath: `/${id}`, createdAt: NOW };
}

function doneRun(runId: string, title: string): RunView {
  return {
    runId,
    taskId: `task-${runId}`,
    projectId: 'p1',
    snapshotId: 'snapshot-p1',
    title,
    attemptId: `attempt-${runId}`,
    attemptNo: 1,
    status: 'FAILED',
    statusReason: null,
    ledger: {
      modelTurns: 1,
      toolCalls: 0,
      selfFixRounds: 0,
      elapsedMs: 10,
      inputTokens: 10,
      outputTokens: 10,
      unknownUsageTurns: 0,
    },
    limits: {
      maxModelTurns: 8,
      maxToolCalls: 20,
      maxSelfFixRounds: 2,
      maxWallClockMs: 60_000,
      maxTotalTokens: 10_000,
    },
    workspaceGeneration: 0,
    createdAt: NOW,
    updatedAt: NOW,
    terminalFacts: null,
    restored: true,
    evidence: 'INTACT',
    evidenceDetail: null,
  };
}

function installBridge(): void {
  window.repopilot = {
    protocolVersion: PROTOCOL_VERSION,
    request: vi.fn(async (method: RequestMethod) => {
      switch (method) {
        case 'core.getStatus':
          return ok({ status: 'READY', detail: 'ready', epoch: 1 });
        case 'doctor.run':
          return ok({ checks: [] });
        case 'project.list':
          return ok({ projects: [project('p1', 'History Project')] });
        case 'model.listProfiles':
          return ok({ profiles: [], secureStorage: true, credentialStore: 'OK', credentialStoreDetail: null });
        case 'run.list':
          // 7 条终态：5 条进"最近"，2 条落进"更早的 N 条"折叠区
          return ok({ runs: Array.from({ length: 7 }, (_, i) => doneRun(`run-${i}`, `任务 ${i}`)) });
        case 'retention.get':
          return ok({
            policy: { evidenceDays: 30, workspaceGraceMinutes: 30 },
            usage: {},
            lastSummary: null,
          });
        default:
          throw new Error(`Unexpected request: ${method}`);
      }
    }) as RepoPilotBridge['request'],
    subscribe: () => () => {},
  } satisfies Partial<RepoPilotBridge> as RepoPilotBridge;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('历史折叠里的清理出口（N9）', () => {
  it('折叠区里有入口，点击打开设置页；入口不在折叠区外', async () => {
    installBridge();
    render(<App />);

    const fold = await screen.findByText(/更早的 2 条/);
    const clean = screen.getByRole('button', { name: /清理历史记录/ });
    // 入口住在折叠区里，不给每个 Run 行都挂一个
    expect(fold.closest('details')!.contains(clean)).toBe(true);

    fireEvent.click(clean);
    // 设置页接管主栏（数据保留卡在其中）
    await screen.findByText('环境自检');
    expect(await screen.findByText('数据保留')).toBeTruthy();
  });
});
