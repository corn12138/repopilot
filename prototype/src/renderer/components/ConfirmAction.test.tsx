// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfirmAction } from './common';

/**
 * 高影响动作的两段式确认。
 *
 * 这里最重要的是**负向**断言：第一次点击绝不能发出请求。
 * Settings 里的删除凭据、删除 Provider、立即清理此前都是一击即发，
 * 而其中两个不可撤销、一个会永久删除磁盘上的证据。
 */
describe('ConfirmAction', () => {
  afterEach(() => cleanup());

  function setup(overrides: Partial<Parameters<typeof ConfirmAction>[0]> = {}) {
    const onConfirm = vi.fn();
    const onArm = vi.fn();
    render(
      <ConfirmAction
        label="立即清理…"
        confirmLabel="确认删除"
        busyLabel="清理中…"
        consequence={{ kind: 'ready', detail: <span>将删除 3 项，释放 1.2 MB</span> }}
        onConfirm={onConfirm}
        onArm={onArm}
        {...overrides}
      />,
    );
    return { onConfirm, onArm };
  }

  it('第一次点击只展开后果，绝不执行', () => {
    const { onConfirm, onArm } = setup();

    fireEvent.click(screen.getByRole('button', { name: '立即清理…' }));

    expect(onConfirm).not.toHaveBeenCalled();
    expect(onArm).toHaveBeenCalledTimes(1);
    expect(screen.getByText('将删除 3 项，释放 1.2 MB')).toBeTruthy();
  });

  it('第二次点击才执行，且执行后回到未武装状态', () => {
    const { onConfirm } = setup();

    fireEvent.click(screen.getByRole('button', { name: '立即清理…' }));
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    // 回到第一段：下一次操作必须重新走一遍确认。
    expect(screen.getByRole('button', { name: '立即清理…' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '确认删除' })).toBeNull();
  });

  it('取消回到未武装状态，不执行', () => {
    const { onConfirm } = setup();

    fireEvent.click(screen.getByRole('button', { name: '立即清理…' }));
    fireEvent.click(screen.getByRole('button', { name: '取消' }));

    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '立即清理…' })).toBeTruthy();
  });

  it('后果还没算出来时根本没有确认按钮 —— 不能让用户在不知道结果时按下去', () => {
    setup({ consequence: { kind: 'pending' } });

    fireEvent.click(screen.getByRole('button', { name: '立即清理…' }));
    expect(screen.queryByRole('button', { name: '确认删除' })).toBeNull();
    expect(screen.getByText('正在计算这次操作的实际影响…')).toBeTruthy();
  });

  /*
   * 这条对应本切片被审出来的最严重缺陷：后果曾经是 `ReactNode | null`，
   * 守卫写的是 `consequence === null`。预演失败时传进来的是一个**非空**的错误节点，
   * 于是守卫失效 —— 横幅上写着"已阻止在不知道后果的情况下执行"，
   * 而它下面那个不可撤销的确认按钮是活的。
   */
  it('算不出后果时不提供确认按钮，只说明为什么被阻止', () => {
    const { onConfirm } = setup({
      consequence: { kind: 'blocked', reason: <strong>无法预演这次清理：超时 —— 已阻止执行。</strong> },
    });

    fireEvent.click(screen.getByRole('button', { name: '立即清理…' }));
    expect(screen.getByText(/已阻止执行/)).toBeTruthy();
    // 负向断言：blocked 状态下确认按钮必须根本不存在，不是"存在但禁用"。
    expect(screen.queryByRole('button', { name: '确认删除' })).toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();
    // 只留一个关闭出口。
    expect(screen.getByRole('button', { name: '关闭' })).toBeTruthy();
  });

  /*
   * 依据变了就必须解除武装：否则用户可以「展开后果 → 改掉策略 → 确认」，
   * 而横幅上还挂着依据旧策略算出来的那段话。
   */
  it('armKey 变化会解除武装，强制重新取一次后果', () => {
    const onConfirm = vi.fn();
    const props = {
      label: '立即清理…',
      confirmLabel: '确认删除',
      busyLabel: '清理中…',
      consequence: { kind: 'ready' as const, detail: <span>将删除 3 项</span> },
      onConfirm,
    };
    const view = render(<ConfirmAction {...props} armKey="policy-30" />);

    fireEvent.click(screen.getByRole('button', { name: '立即清理…' }));
    expect(screen.getByRole('button', { name: '确认删除' })).toBeTruthy();

    // 用户改了策略并保存 —— 已展开的后果作废。
    view.rerender(<ConfirmAction {...props} armKey="policy-1" />);
    expect(screen.queryByRole('button', { name: '确认删除' })).toBeNull();
    expect(screen.getByRole('button', { name: '立即清理…' })).toBeTruthy();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('busy 时两段都不可点，并带 aria-busy', () => {
    const { onConfirm } = setup({ busy: true });
    const trigger = screen.getByRole('button', { name: '清理中…' });
    expect(trigger.hasAttribute('disabled')).toBe(true);
    expect(trigger.getAttribute('aria-busy')).toBe('true');
    fireEvent.click(trigger);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('后果文案里不出现估算词 —— 影响预览必须是算出来的事实', () => {
    setup({ consequence: { kind: 'ready', detail: <span>将删除 3 项，释放 1.2 MB</span> } });
    fireEvent.click(screen.getByRole('button', { name: '立即清理…' }));
    /*
     * 粗糙但有效的守卫：一个猜出来的影响预览比没有更糟，因为它同样会被当成承诺。
     * 这条断言挡住的是"以后有人顺手加一句『预计释放约 xx』"。
     */
    const text = screen.getByRole('group').textContent ?? '';
    for (const weasel of ['预计', '大约', '约 ', '可能删除']) {
      expect(text.includes(weasel), `确认文案不应出现估算词「${weasel}」`).toBe(false);
    }
  });
});
