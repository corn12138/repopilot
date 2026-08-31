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

  it('阶段流转渲染为相位锚点（v0.1 #6）：分组结构，不再折叠也不再计入省略', () => {
    const events = [
      event('RUN_CREATED', '任务已创建：修构建'),
      event('STATUS_CHANGED', '进入规划', { to: 'PLANNING' }),
      event('STATUS_CHANGED', '进入执行', { to: 'EXECUTING' }),
      event('STATUS_CHANGED', '进入验证', { to: 'VERIFYING' }),
      event('STATUS_CHANGED', '已成功', { to: 'SUCCEEDED' }),
    ];
    render(<Transcript events={events} toolCalls={[]} />);

    // 三个相位各有一条锚点分隔行，原始 summary 收进 title
    const anchors = screen.getAllByRole('separator');
    expect(anchors.map((a) => a.textContent?.slice(0, 4))).toEqual(
      expect.arrayContaining([expect.stringContaining('规划'), expect.stringContaining('执行'), expect.stringContaining('验证')]),
    );
    expect(screen.getByLabelText('进入执行阶段').title).toBe('进入执行');
    // 终态仍是完整的状态行，不降级成锚点
    expect(screen.getByText('已成功')).toBeTruthy();
    // 相位事件都被渲染了 —— 不再有省略报数，也没有展开按钮
    expect(screen.queryByText(/时间线省略了/)).toBeNull();
    expect(screen.queryByRole('button', { name: /展开这/ })).toBeNull();
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

describe('平台发起的验证命令：合并进省略说明，不重复展示', () => {
  // 上一个 describe 的 cleanup 不覆盖这里；不清理会让上一条用例的 DOM 与本条叠加
  afterEach(() => {
    cleanup();
  });

  it('verify_command 的 ToolCall 不单独成行，但被点名报数（结果由验证块呈现）', () => {
    const events = [
      event('TOOL_CALL_PROPOSED', '提议工具调用', { toolCallId: 'v-1' }),
      event('TOOL_CALL_PROPOSED', '提议工具调用', { toolCallId: 'v-2' }),
      event('VERIFICATION_FINISHED', '基线存在失败', {
        verification: {
          phase: 'BASELINE',
          passed: false,
          commands: [
            { commandId: 'build', argv: ['pnpm', 'build'], outcome: 'EXIT_NONZERO', exitCode: 1, signal: null, durationMs: 5, stdoutPreview: '', stderrPreview: 'TS2345', outputTruncated: false },
          ],
        },
      }),
    ];
    render(
      <Transcript
        events={events}
        toolCalls={[
          toolCall({ toolCallId: 'v-1', toolName: 'verify_command', risk: 'R1', argsSummary: 'BASELINE build: pnpm build' }),
          toolCall({ toolCallId: 'v-2', toolName: 'verify_command', risk: 'R1', argsSummary: 'BASELINE typecheck: pnpm typecheck' }),
        ]}
      />,
    );

    // 不重复展示：命令行不出现在时间线里
    expect(screen.queryByText('BASELINE build: pnpm build')).toBeNull();
    // 但必须报数并说明去向 —— 静默丢弃与静默通过是同一类问题
    // merged 与 omitted 分开计数：它不是"被省略"，是"并入了验证块"
    expect(screen.getByText(/另有 2 条事件没有单独成行/)).toBeTruthy();
    expect(screen.getByText(/平台发起的验证命令调用（已计入预算账本）/)).toBeTruthy();
    // 验证块本身照常呈现结果
    expect(screen.getByText(/TS2345/)).toBeTruthy();
  });

  it('对照：模型发起的 run_command 仍然单独成行', () => {
    const events = [
      event('MODEL_INVOCATION', 'EXECUTION 调用 claude'),
      event('TOOL_CALL_PROPOSED', '提议工具调用', { toolCallId: 'c-1' }),
    ];
    render(
      <Transcript
        events={events}
        toolCalls={[toolCall({ toolCallId: 'c-1', toolName: 'run_command', risk: 'R1', argsSummary: 'pnpm build' })]}
      />,
    );
    /*
     * 模型发起的命令归进那一组里，摘要照常可见。
     * 组标题说人话（"运行命令 pnpm build"），raw 工具名进 title ——
     * 与 RUN_STATUS_TEXT / RiskBadge 同一条规矩。
     */
    const head = screen.getByText('运行命令 pnpm build');
    // 组里那一行照常带着命令原文（组标题之外还有一处，所以用 getAllByText）
    expect(screen.getAllByText(/pnpm build/).length).toBeGreaterThan(1);
    // 命令组默认展开：输出通常就是用户要找的东西，藏进折叠层等于把信号收走
    expect((head.closest('details') as HTMLDetailsElement).open).toBe(true);
  });
});

describe('COMMAND_APPROVAL_BOUND：逐条批准的 R2 命令要有自己的一行', () => {
  it('批准事件渲染成可见行，不被折进"省略了 N 条"', () => {
    render(
      <Transcript
        events={[
          event('RUN_CREATED', '任务已创建：修 CI'),
          event('COMMAND_APPROVAL_BOUND', '你逐条批准了 R2 命令「bash scripts/test.sh」作为 user1（一次性，只对本次运行有效）', {
            approvalId: 'capp_1',
            commandId: 'user1',
          }),
        ]}
        toolCalls={[]}
      />,
    );
    expect(screen.getByText(/逐条批准了 R2 命令/)).toBeTruthy();
    // 它不该同时出现在省略提示里
    expect(screen.queryByText(/COMMAND_APPROVAL_BOUND/)).toBeNull();
  });

  it('每一次执行（COMMAND_APPROVAL_USED）并进省略提示：内容在 verify_command 那一行上', () => {
    render(
      <Transcript
        events={[
          event('RUN_CREATED', '任务已创建：修 CI'),
          event('COMMAND_APPROVAL_USED', '按批准执行 R2 命令「bash scripts/test.sh」（BASELINE，第 1 次）'),
        ]}
        toolCalls={[]}
      />,
    );
    expect(screen.queryByText(/按批准执行 R2 命令/)).toBeNull();
  });
});

describe('ATTEMPT_STARTED：新一次尝试是看得见的分隔', () => {
  afterEach(() => {
    cleanup();
  });

  it('单独成行（平台口吻），并且新尝试的工具调用不挂到上一次的模型轮次下', () => {
    const events = [
      event('MODEL_INVOCATION', 'PLANNING 调用 deepseek'),
      event('TOOL_CALL_PROPOSED', '提议工具调用', { toolCallId: 'a-1' }),
      event('ATTEMPT_STARTED', '用户要求修改 → 开始第 2 次尝试（上一版补丁 sha256:abc 已封存为历史）', {
        attemptNo: 2,
      }),
      event('TOOL_CALL_PROPOSED', '提议工具调用', { toolCallId: 'a-2' }),
    ];
    render(
      <Transcript
        events={events}
        toolCalls={[
          toolCall({ toolCallId: 'a-1', toolName: 'fs_read', argsSummary: 'src/one.ts' }),
          toolCall({ toolCallId: 'a-2', toolName: 'fs_read', argsSummary: 'src/two.ts' }),
        ]}
      />,
    );
    expect(screen.getByText(/开始第 2 次尝试/)).toBeTruthy();
    /*
     * 第一次尝试的调用在它那一组里；第二次的不在 —— ATTEMPT_STARTED 切断了
     * currentTurn，所以 src/two.ts 根本不属于上一轮，也就并不进上一组。
     * （切断之后没有新的 MODEL_INVOCATION，那次调用退回平铺，不丢事件。）
     */
    const groups = document.querySelectorAll('details.toolgroup');
    expect(groups).toHaveLength(1);
    expect(groups[0]!.textContent).toContain('src/one.ts');
    expect(groups[0]!.textContent).not.toContain('src/two.ts');
    expect(screen.getByText('src/two.ts')).toBeTruthy();
  });
});

describe('详情页降噪（交互评审 v0.2 N5）：报数常驻，计量与明细各退一层', () => {
  afterEach(() => {
    seq = 0;
    cleanup();
  });

  it('轮次行的 per-call token 收进 title，行上留模型名 —— 全角/半角括号都认', () => {
    // Core 的真实 summary 用全角括号；只测半角曾与只匹配半角的实现互相印证成假绿
    const events = [
      event('MODEL_INVOCATION', 'PLANNING 调用 deepseek-v4-pro（in=12938 out=1485）'),
      event('MODEL_INVOCATION', 'EXECUTING 调用 local-model (in=7 out=9)'),
    ];
    render(<Transcript events={events} toolCalls={[]} />);

    // 行上不再有第三遍 token 计量（总量在用量面板，逐笔在数据出站）
    expect(screen.queryByText(/in=12938/)).toBeNull();
    expect(screen.queryByText(/in=7/)).toBeNull();
    expect(screen.getByText('deepseek-v4-pro').getAttribute('title')).toContain('in=12938 out=1485');
    expect(screen.getByText('local-model').getAttribute('title')).toContain('in=7 out=9');
  });

  it('没有 token 后缀的轮次行原样保留，不误伤', () => {
    const events = [event('MODEL_INVOCATION', 'PLANNING 调用 本地模型')];
    render(<Transcript events={events} toolCalls={[]} />);
    const detail = screen.getByText('本地模型');
    expect(detail.getAttribute('title')).toBeNull();
  });

  it('省略披露：报数一行常驻，分类明细收进「省略明细」折叠层且默认收起', () => {
    const events = [
      event('RUN_CREATED', '任务已创建'),
      // 有事件、没有对应的 ToolCallView：正文不可恢复的省略
      event('MODEL_INVOCATION', 'agent 调用 修复'),
      event('TOOL_CALL_PROPOSED', '提议工具调用', { toolCallId: 'missing-1' }),
      event('CLEANUP_SUMMARY', '清理完成'),
    ];
    render(<Transcript events={events} toolCalls={[]} />);

    // 报数在折叠层外，一直可见
    expect(screen.getByText('时间线省略了 2 条事件')).toBeTruthy();
    const fold = screen.getByText('省略明细').closest('details')!;
    expect(fold.open).toBe(false);
    // 明细仍在 DOM（降层级不删事实）
    expect(screen.getByText(/工具调用事件存在/)).toBeTruthy();
    expect(screen.getByText(/CLEANUP_SUMMARY×1/)).toBeTruthy();
  });
});

describe('终端输出行数上限（交互评审 v0.2 N10）：折叠 + 报数', () => {
  afterEach(() => {
    seq = 0;
    cleanup();
  });

  it('超长输出默认前 14 行，剩余行数如实报出，可展开可收回', () => {
    const long = Array.from({ length: 40 }, (_, i) => `line-${i + 1}`).join('\n');
    const events = [
      event('MODEL_INVOCATION', 'EXECUTING 调用 模型'),
      event('TOOL_CALL_PROPOSED', '执行命令', { toolCallId: 'term-1' }),
    ];
    render(
      <Transcript
        events={events}
        toolCalls={[toolCall({ toolCallId: 'term-1', toolName: 'run_command', preview: long, resolution: 'FAILED' })]}
      />,
    );

    expect(screen.getByText(/line-14/)).toBeTruthy();
    expect(screen.queryByText(/line-15/)).toBeNull();
    const expand = screen.getByRole('button', { name: '还有 26 行 —— 展开全部' });
    fireEvent.click(expand);
    expect(screen.getByText(/line-40/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '收起到前 14 行' }));
    expect(screen.queryByText(/line-40/)).toBeNull();
  });

  it('少量超出（不足上限+余量）不折叠，不放没意义的按钮', () => {
    const short = Array.from({ length: 16 }, (_, i) => `s-${i + 1}`).join('\n');
    const events = [
      event('MODEL_INVOCATION', 'EXECUTING 调用 模型'),
      event('TOOL_CALL_PROPOSED', '执行命令', { toolCallId: 'term-2' }),
    ];
    render(
      <Transcript
        events={events}
        toolCalls={[toolCall({ toolCallId: 'term-2', toolName: 'run_command', preview: short, resolution: 'FAILED' })]}
      />,
    );
    expect(screen.getByText(/s-16/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /展开全部/ })).toBeNull();
  });
});

describe('相邻同族调用并成一组（Layer 0）', () => {
  afterEach(() => {
    seq = 0;
    cleanup();
  });

  function reads(ids: string[]): ToolCallView[] {
    return ids.map((id) => toolCall({ toolCallId: id, toolName: 'fs_read', argsSummary: `src/${id}.ts` }));
  }

  it('跨轮合并：一轮一调用的连续读取收成一组，不再一轮一张卡', () => {
    // 真机上的形态：模型每轮只读一个文件，连读五轮
    const events = [
      event('MODEL_INVOCATION', 'EXECUTION 调用 m'),
      event('TOOL_CALL_PROPOSED', '提议', { toolCallId: 'a' }),
      event('MODEL_INVOCATION', 'EXECUTION 调用 m'),
      event('TOOL_CALL_PROPOSED', '提议', { toolCallId: 'b' }),
      event('MODEL_INVOCATION', 'EXECUTION 调用 m'),
      event('TOOL_CALL_PROPOSED', '提议', { toolCallId: 'c' }),
    ];
    render(<Transcript events={events} toolCalls={reads(['a', 'b', 'c'])} />);

    const groups = document.querySelectorAll('details.toolgroup');
    expect(groups).toHaveLength(1);
    expect(screen.getByText('读取文件 · 3 次')).toBeTruthy();
    // 覆盖了哪几轮、哪个模型没有消失，只是降到 title
    expect(groups[0]!.querySelector('summary')!.title).toContain('#1–#3');
    // 三次调用都还在，一条都没丢
    for (const p of ['src/a.ts', 'src/b.ts', 'src/c.ts']) {
      expect(groups[0]!.textContent).toContain(p);
    }
    // 只读探索默认收起 —— 这是"啥也看不出来"的噪声主体
    expect((groups[0] as HTMLDetailsElement).open).toBe(false);
    // 而且没有任何东西被记成省略：调用全在组里
    expect(screen.queryByText(/时间线省略了/)).toBeNull();
  });

  it('只有一次调用时标题就带上参数，不逼人为了看一个文件名去点开', () => {
    const events = [
      event('MODEL_INVOCATION', 'EXECUTION 调用 m'),
      event('TOOL_CALL_PROPOSED', '提议', { toolCallId: 'a' }),
    ];
    render(<Transcript events={events} toolCalls={reads(['a'])} />);
    expect(screen.getByText('读取文件 src/a.ts')).toBeTruthy();
  });

  it('不同族不合并，改文件的调用永远单独成行且默认展开', () => {
    const events = [
      event('MODEL_INVOCATION', 'EXECUTION 调用 m'),
      event('TOOL_CALL_PROPOSED', '提议', { toolCallId: 'a' }),
      event('MODEL_INVOCATION', 'EXECUTION 调用 m'),
      event('TOOL_CALL_PROPOSED', '提议', { toolCallId: 'w' }),
      event('MODEL_INVOCATION', 'EXECUTION 调用 m'),
      event('TOOL_CALL_PROPOSED', '提议', { toolCallId: 'r' }),
    ];
    render(
      <Transcript
        events={events}
        toolCalls={[
          ...reads(['a']),
          toolCall({ toolCallId: 'w', toolName: 'workspace_mutate', risk: 'R1', argsSummary: 'src/app.ts' }),
          toolCall({ toolCallId: 'r', toolName: 'run_command', risk: 'R1', argsSummary: 'pnpm build' }),
        ]}
      />,
    );
    // 读 / 改 / 跑 三段各自独立：mutate 那一轮不并组，落回 turn 卡片
    expect(document.querySelectorAll('details.toolgroup')).toHaveLength(2);
    const mutate = screen.getByTitle('workspace_mutate').closest('details') as HTMLDetailsElement;
    expect(mutate.open).toBe(true);
  });

  it('组里有失败就强制展开，失败不许藏在折叠层里', () => {
    const events = [
      event('MODEL_INVOCATION', 'EXECUTION 调用 m'),
      event('TOOL_CALL_PROPOSED', '提议', { toolCallId: 'a' }),
      event('MODEL_INVOCATION', 'EXECUTION 调用 m'),
      event('TOOL_CALL_PROPOSED', '提议', { toolCallId: 'b' }),
    ];
    render(
      <Transcript
        events={events}
        toolCalls={[
          ...reads(['a']),
          toolCall({ toolCallId: 'b', toolName: 'fs_read', argsSummary: 'src/b.ts', resolution: 'FAILED' }),
        ]}
      />,
    );
    const group = document.querySelector('details.toolgroup') as HTMLDetailsElement;
    expect(group.open).toBe(true);
    expect(screen.getByText('1 失败')).toBeTruthy();
  });

  it('没有工具调用的那一轮是一条安静的行，不是一张写着「没有工具调用」的卡片', () => {
    render(<Transcript events={[event('MODEL_INVOCATION', 'EXECUTION 调用 m')]} toolCalls={[]} />);
    expect(screen.queryByText('没有工具调用')).toBeNull();
    expect(document.querySelector('.turn-quiet')).toBeTruthy();
    expect(document.querySelector('details.turn')).toBeNull();
    // 用途说人话，raw 枚举进 title
    expect(screen.getByText('执行').title).toBe('EXECUTION');
  });
});

describe('活动指示（Layer 0）：非终态时说清楚在等什么', () => {
  afterEach(() => {
    seq = 0;
    cleanup();
  });

  it('最后一条是模型调用 → 在等模型', () => {
    render(
      <Transcript events={[event('MODEL_INVOCATION', 'EXECUTION 调用 m')]} toolCalls={[]} runStatus="EXECUTING" />,
    );
    expect(screen.getByRole('status').textContent).toContain('模型正在思考');
  });

  it('有未 resolve 的调用 → 指名道姓说在跑哪一个', () => {
    render(
      <Transcript
        events={[event('MODEL_INVOCATION', 'EXECUTION 调用 m'), event('TOOL_CALL_PROPOSED', '提议', { toolCallId: 'x' })]}
        toolCalls={[toolCall({ toolCallId: 'x', toolName: 'run_command', argsSummary: 'pnpm build', resolution: null })]}
        runStatus="EXECUTING"
      />,
    );
    expect(screen.getByRole('status').textContent).toContain('正在运行命令：pnpm build');
  });

  it('终态不显示活动指示；等用户决定时也不显示（球在用户那边）', () => {
    const events = [event('MODEL_INVOCATION', 'EXECUTION 调用 m')];
    const { unmount } = render(<Transcript events={events} toolCalls={[]} runStatus="FAILED" />);
    expect(screen.queryByRole('status')).toBeNull();
    unmount();
    render(<Transcript events={events} toolCalls={[]} runStatus="AWAITING_PLAN_APPROVAL" />);
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('模型正文按 Markdown 呈现（Layer 0）', () => {
  afterEach(() => {
    seq = 0;
    cleanup();
  });

  it('标题/粗体/行内码/列表都成结构，标记字符不再当正文印出来', () => {
    render(
      <Transcript
        events={[
          event('NOTE', '## 我了解到的项目情况\n\n**Monorepo 结构**\n\n- `apps/web` — React 18\n- `apps/api` — NestJS'),
        ]}
        toolCalls={[]}
      />,
    );
    expect(screen.getByText('我了解到的项目情况')).toBeTruthy();
    expect(screen.getByText('Monorepo 结构').tagName).toBe('STRONG');
    expect(screen.getByText('apps/web').tagName).toBe('CODE');
    expect(document.querySelectorAll('.prose-list li')).toHaveLength(2);
    // 标题不进标题大纲：这是聊天流里的一段话，不是文档
    expect(document.querySelector('h1, h2, h3')).toBeNull();
  });

  it('用户自己打的字逐字原样显示，不走 Markdown 重排', () => {
    render(<Transcript events={[event('RUN_CREATED', '任务已创建：修 **构建**')]} toolCalls={[]} />);
    expect(screen.getByText('修 **构建**')).toBeTruthy();
  });
});

describe('模型说的话回到模型名下（Layer 2）', () => {
  afterEach(() => {
    seq = 0;
    cleanup();
  });

  it('ASSISTANT_MESSAGE 署名「AI」，NOTE 仍署名「平台」—— 归属不许混', () => {
    render(
      <Transcript
        events={[
          event('MODEL_INVOCATION', 'EXECUTION 调用 deepseek-v4-pro（in=1 out=2）'),
          event('ASSISTANT_MESSAGE', '我读完了配置。', { purpose: 'EXECUTION', truncated: false, fullLength: 7 }),
          event('NOTE', '未验证模式：不跑基线'),
        ]}
        toolCalls={[]}
      />,
    );
    const ai = screen.getByText('AI').closest('.msg')!;
    expect(ai.textContent).toContain('我读完了配置。');
    expect(ai.className).toContain('agent');

    const platform = screen.getByText('平台').closest('.msg')!;
    expect(platform.textContent).toContain('未验证模式');
    // 平台那条绝不能署名 AI —— 那是把平台的诚实标注记在模型头上
    expect(platform.textContent).not.toContain('我读完了配置。');
  });

  it('归属跟着走：说话的是哪一轮、哪个模型、哪一段用途', () => {
    render(
      <Transcript
        events={[
          event('MODEL_INVOCATION', 'PLANNING 调用 deepseek-v4-pro（in=1 out=2）'),
          event('ASSISTANT_MESSAGE', '先看一下目录结构。', { purpose: 'PLANNING', truncated: false, fullLength: 9 }),
        ]}
        toolCalls={[]}
      />,
    );
    // 用途说人话，模型名与轮次都在
    expect(screen.getByText('#1 · 规划 · deepseek-v4-pro')).toBeTruthy();
  });

  it('截断如实报数：说清只显示了多少、原文多长', () => {
    render(
      <Transcript
        events={[
          event('MODEL_INVOCATION', 'EXECUTION 调用 m'),
          event('ASSISTANT_MESSAGE', '前一段', { purpose: 'EXECUTION', truncated: true, fullLength: 9000 }),
        ]}
        toolCalls={[]}
      />,
    );
    const notice = screen.getByText(/这段话被截断了/);
    expect(notice.textContent).toContain('只显示前 3 字');
    expect(notice.textContent).toContain('原文共 9000 字');
  });

  it('正文提出折叠层，排在这一轮的调用之前 —— 最该读的东西不许藏起来', () => {
    const events = [
      event('MODEL_INVOCATION', 'EXECUTION 调用 m'),
      event('ASSISTANT_MESSAGE', '我要去读这两个文件。', { purpose: 'EXECUTION', truncated: false, fullLength: 10 }),
      event('TOOL_CALL_PROPOSED', '提议', { toolCallId: 'a' }),
      event('TOOL_CALL_PROPOSED', '提议', { toolCallId: 'b' }),
    ];
    render(
      <Transcript
        events={events}
        toolCalls={[
          toolCall({ toolCallId: 'a', argsSummary: 'src/a.ts' }),
          toolCall({ toolCallId: 'b', argsSummary: 'src/b.ts' }),
        ]}
      />,
    );
    const say = screen.getByText('我要去读这两个文件。');
    const group = document.querySelector('details.toolgroup')!;
    // 正文在折叠层外
    expect(group.contains(say)).toBe(false);
    // 且排在调用组前面（说了要干什么，再干）
    expect(say.closest('.msg')!.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText('读取文件 · 2 次')).toBeTruthy();
  });

  it('「读一批 → 说一句 → 再读一批」分成两组，不并成一坨', () => {
    const events = [
      event('MODEL_INVOCATION', 'EXECUTION 调用 m'),
      event('TOOL_CALL_PROPOSED', '提议', { toolCallId: 'a' }),
      event('MODEL_INVOCATION', 'EXECUTION 调用 m'),
      event('ASSISTANT_MESSAGE', '找到了，再看一处。', { purpose: 'EXECUTION', truncated: false, fullLength: 9 }),
      event('TOOL_CALL_PROPOSED', '提议', { toolCallId: 'b' }),
    ];
    render(
      <Transcript
        events={events}
        toolCalls={[
          toolCall({ toolCallId: 'a', argsSummary: 'src/a.ts' }),
          toolCall({ toolCallId: 'b', argsSummary: 'src/b.ts' }),
        ]}
      />,
    );
    const groups = document.querySelectorAll('details.toolgroup');
    expect(groups).toHaveLength(2);
    expect(groups[0]!.textContent).toContain('src/a.ts');
    expect(groups[1]!.textContent).toContain('src/b.ts');
  });

  it('只说话没调工具的那一轮不再画空卡片，只留那段话', () => {
    render(
      <Transcript
        events={[
          event('MODEL_INVOCATION', 'EXECUTION 调用 m'),
          event('ASSISTANT_MESSAGE', '## 我了解到的\n\n改完了。', { purpose: 'EXECUTION', truncated: false, fullLength: 12 }),
        ]}
        toolCalls={[]}
      />,
    );
    expect(document.querySelector('details.turn')).toBeNull();
    expect(document.querySelector('.turn-quiet')).toBeNull();
    // 而且按 Markdown 呈现 —— 这正是真机上把 `##` 当正文印出来的那一段
    expect(screen.getByText('我了解到的')).toBeTruthy();
    expect(screen.queryByText(/^## /)).toBeNull();
  });
});

describe('实时增量（Layer 3）：先看一眼，不是记录', () => {
  afterEach(() => {
    seq = 0;
    cleanup();
  });

  it('流进来的正文按 Markdown 渲染，并与"已经写下来的"在视觉上有别', () => {
    render(<Transcript events={[]} toolCalls={[]} runStatus="EXECUTING" liveText={'正在读 `src/a.ts`'} />);
    const live = document.querySelector('.msg.agent.live')!;
    expect(live).toBeTruthy();
    expect(live.querySelector('code')!.textContent).toBe('src/a.ts');
    // 还没说完，所以不给时间戳，也不带归属小字（那是记录才有的东西）
    expect(live.querySelector('.say-attribution')).toBeNull();
  });

  it('只有实时增量、还没有任何事件时也要显示，不能报"还没有内容"', () => {
    render(<Transcript events={[]} toolCalls={[]} runStatus="PLANNING" liveText="思考中的第一句" />);
    expect(screen.queryByText(/还没有内容/)).toBeNull();
    expect(screen.getByText('思考中的第一句')).toBeTruthy();
  });

  it('空字符串不渲染空气泡', () => {
    render(<Transcript events={[event('RUN_CREATED', '任务已创建：修构建')]} toolCalls={[]} liveText="" />);
    expect(document.querySelector('.msg.agent.live')).toBeNull();
  });
});
