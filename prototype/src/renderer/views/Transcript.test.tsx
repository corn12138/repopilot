// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { RunEvent, RunEventKind, ToolCallView } from '@shared/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { Transcript } from './Transcript';

let seq = 0;

function event(
  kind: RunEventKind,
  summary: string,
  payload: Record<string, unknown> = {},
): RunEvent {
  seq += 1;
  return {
    seq,
    runId: 'run-1',
    attemptId: 'attempt-1',
    kind,
    at: '2026-08-13T00:00:00.000Z',
    summary,
    payload,
  };
}

function toolCall(overrides: Partial<ToolCallView> = {}): ToolCallView {
  return {
    toolCallId: 'tool-1',
    runId: 'run-1',
    attemptId: 'attempt-1',
    toolName: 'fs_read',
    argsSummary: 'src/app.ts',
    argsDigest: 'sha256:args',
    risk: 'R0',
    resolution: 'SUCCEEDED',
    resolutionReason: null,
    preview: 'const a = 1;',
    previewTruncated: false,
    artifactRef: null,
    durationMs: 12,
    startedAt: '2026-08-13T00:00:00.000Z',
    resolvedAt: '2026-08-13T00:00:00.000Z',
    ...overrides,
  };
}

describe('Transcript 省略披露', () => {
  afterEach(() => {
    seq = 0;
    cleanup();
  });

  it('折叠常规阶段流转时报出数量与原因，并能就地展开和收回', () => {
    const events = [
      event('RUN_CREATED', '任务已创建：修构建'),
      event('STATUS_CHANGED', '进入规划', { to: 'PLANNING' }),
      event('STATUS_CHANGED', '进入执行', { to: 'EXECUTING' }),
      event('STATUS_CHANGED', '进入验证', { to: 'VERIFYING' }),
      event('STATUS_CHANGED', '已成功', { to: 'SUCCEEDED' }),
    ];
    render(<Transcript events={events} toolCalls={[]} />);

    expect(screen.getByText('时间线省略了 3 条事件')).toBeTruthy();
    expect(screen.getByText(/常规阶段流转（PLANNING \/ EXECUTING \/ VERIFYING）/)).toBeTruthy();
    // 折叠状态下这三条不该出现在时间线里。
    expect(screen.queryByText('进入执行')).toBeNull();

    const expand = screen.getByRole('button', { name: '展开这 3 条' });
    expect(expand.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(expand);

    expect(screen.getByText('进入执行')).toBeTruthy();
    expect(screen.getByText('常规阶段流转已全部展开')).toBeTruthy();
    const collapse = screen.getByRole('button', { name: '重新折叠常规阶段流转' });
    expect(collapse.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(collapse);
    expect(screen.getByText('时间线省略了 3 条事件')).toBeTruthy();
  });

  it('把无法展示正文的省略与可展开的省略分开报数', () => {
    const events = [
      event('MODEL_INVOCATION', 'agent 调用 修复'),
      // 有事件、没有对应的 ToolCallView：正文不可恢复。
      event('TOOL_CALL_PROPOSED', '提议工具调用', { toolCallId: 'missing-1' }),
      event('TOOL_CALL_PROPOSED', '提议工具调用', { toolCallId: 'tool-1' }),
      event('TOOL_CALL_PROPOSED', '重复引用', { toolCallId: 'tool-1' }),
      event('VERIFICATION_FINISHED', '验证结束'), // 缺 payload.verification
      event('CLEANUP_SUMMARY', '清理完成'),
    ];
    render(<Transcript events={events} toolCalls={[toolCall()]} />);

    expect(screen.getByText('时间线省略了 4 条事件')).toBeTruthy();
    expect(screen.getByText(/工具调用事件存在，但对应的调用详情尚未回填/)).toBeTruthy();
    expect(screen.getByText(/同一次工具调用的重复事件引用/)).toBeTruthy();
    expect(screen.getByText(/验证完成事件缺少 verification 正文/)).toBeTruthy();
    expect(screen.getByText(/没有其他呈现的事件种类：CLEANUP_SUMMARY×1/)).toBeTruthy();
    // 这些都没有就地入口，所以不提供展开按钮。
    expect(screen.queryByRole('button', { name: /展开这/ })).toBeNull();
    expect(screen.getAllByText('（正文不可恢复）').length).toBe(4);
  });

  it('内容已并入其他行的事件单独报数，不计入"省略"标题', () => {
    const events = [
      event('RUN_CREATED', '任务已创建：修构建'),
      event('TOOL_CALL_RESOLVED', '工具调用完成', { toolCallId: 'tool-1' }),
      event('TOOL_CALL_RESOLVED', '工具调用完成', { toolCallId: 'tool-2' }),
      event('VERIFICATION_STARTED', '开始验证'),
      event('CROSS_REVIEW_FINISHED', '交叉审核结束'),
    ];
    render(<Transcript events={events} toolCalls={[]} />);

    /*
     * 这四条不是"信息丢了"，它们画在工具行、验证行与交叉审核卡上。
     * 如果把它们算进"省略了 N 条"，每个 Run 都会报一次假警，报数就失去意义。
     */
    expect(screen.getByText('没有事件被省略')).toBeTruthy();
    expect(screen.getByText(/另有 4 条事件没有单独成行/)).toBeTruthy();
    expect(screen.getByText(/TOOL_CALL_RESOLVED×2/)).toBeTruthy();
    expect(screen.queryByText(/时间线省略了/)).toBeNull();
  });

  it('没有任何省略也没有并入项时，不显示披露块', () => {
    render(<Transcript events={[event('RUN_CREATED', '任务已创建：修构建')]} toolCalls={[]} />);
    expect(screen.queryByText(/时间线省略了/)).toBeNull();
    expect(screen.queryByText(/另有/)).toBeNull();
    expect(screen.queryByText('没有事件被省略')).toBeNull();
  });

  it('预览被截断时说明它是截断的，并给出完整 artifact 入口', () => {
    const events = [
      event('MODEL_INVOCATION', 'agent 调用 修复'),
      event('TOOL_CALL_PROPOSED', '提议工具调用', { toolCallId: 'tool-1' }),
    ];
    render(
      <Transcript
        events={events}
        toolCalls={[toolCall({ previewTruncated: true, artifactRef: 'artifact://tool-1' })]}
      />,
    );

    expect(screen.getByText('上面只是预览，正文已被截断。')).toBeTruthy();
    expect(screen.getByText('artifact://tool-1')).toBeTruthy();
  });

  it('截断但没有封存 artifact 时明说找不回来，不假装完整', () => {
    const events = [
      event('MODEL_INVOCATION', 'agent 调用 修复'),
      event('TOOL_CALL_PROPOSED', '提议工具调用', { toolCallId: 'tool-1' }),
    ];
    render(
      <Transcript
        events={events}
        toolCalls={[toolCall({ previewTruncated: true, artifactRef: null })]}
      />,
    );

    expect(screen.getByText('上面只是预览，正文已被截断。')).toBeTruthy();
    expect(screen.getByText('这次调用没有封存完整 artifact，被截掉的部分无法找回。')).toBeTruthy();
  });
});
