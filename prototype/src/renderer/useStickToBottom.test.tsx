// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useStickToBottom } from './useStickToBottom';

/**
 * jsdom 没有布局，`scrollHeight` / `clientHeight` 永远是 0，`scrollTop` 的 setter 是空操作。
 * 这里给节点装上可控的滚动度量，于是「用户在哪」「有没有被抢滚动」都能被断言 ——
 * 而不是靠"看起来对"。
 */
function installScrollMetrics(
  element: HTMLElement,
  initial: { scrollHeight: number; clientHeight: number },
) {
  const box = { ...initial, scrollTop: 0 };
  Object.defineProperty(element, 'scrollHeight', {
    configurable: true,
    get: () => box.scrollHeight,
  });
  Object.defineProperty(element, 'clientHeight', {
    configurable: true,
    get: () => box.clientHeight,
  });
  Object.defineProperty(element, 'scrollTop', {
    configurable: true,
    get: () => box.scrollTop,
    set: (value: number) => {
      box.scrollTop = value;
    },
  });
  return box;
}

function Harness({ ownerKey, itemCount }: { ownerKey: string | null; itemCount: number }) {
  const follow = useStickToBottom<HTMLDivElement>({ ownerKey, itemCount });
  return (
    <div>
      <div data-testid="scroller" ref={follow.containerRef} />
      <span data-testid="pending">{follow.pendingCount}</span>
      <span data-testid="pinned">{String(follow.pinned)}</span>
      <button onClick={follow.jumpToBottom}>回到最新</button>
    </div>
  );
}

const pending = () => Number(screen.getByTestId('pending').textContent);
const pinned = () => screen.getByTestId('pinned').textContent;

describe('useStickToBottom', () => {
  afterEach(() => {
    cleanup();
  });

  it('用户在底部阈值内时跟随新条目，不产生未读计数', () => {
    const view = render(<Harness ownerKey="run-a" itemCount={3} />);
    const box = installScrollMetrics(screen.getByTestId('scroller'), {
      scrollHeight: 300,
      clientHeight: 300,
    });
    fireEvent.scroll(screen.getByTestId('scroller'));
    expect(pinned()).toBe('true');

    box.scrollHeight = 420;
    view.rerender(<Harness ownerKey="run-a" itemCount={5} />);

    expect(box.scrollTop).toBe(420);
    expect(pending()).toBe(0);
  });

  it('用户向上阅读时绝不移动滚动位置，只累计准确的新事件数', () => {
    const view = render(<Harness ownerKey="run-a" itemCount={3} />);
    const box = installScrollMetrics(screen.getByTestId('scroller'), {
      scrollHeight: 1000,
      clientHeight: 200,
    });
    // 距底 700px，远超 64px 阈值 —— 用户正在往回读。
    box.scrollTop = 100;
    fireEvent.scroll(screen.getByTestId('scroller'));
    expect(pinned()).toBe('false');

    box.scrollHeight = 1200;
    view.rerender(<Harness ownerKey="run-a" itemCount={5} />);
    box.scrollHeight = 1300;
    view.rerender(<Harness ownerKey="run-a" itemCount={6} />);

    expect(box.scrollTop).toBe(100);
    expect(pending()).toBe(3);
  });

  it('「回到最新」按钮可键盘触发，跳到底部并清零计数', () => {
    const view = render(<Harness ownerKey="run-a" itemCount={1} />);
    const box = installScrollMetrics(screen.getByTestId('scroller'), {
      scrollHeight: 900,
      clientHeight: 200,
    });
    box.scrollTop = 0;
    fireEvent.scroll(screen.getByTestId('scroller'));
    view.rerender(<Harness ownerKey="run-a" itemCount={4} />);
    expect(pending()).toBe(3);

    // 真 button：键盘的 Enter 会被浏览器翻译成 click，这里直接断言同一入口。
    const button = screen.getByRole('button', { name: '回到最新' });
    button.focus();
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);

    expect(box.scrollTop).toBe(900);
    expect(pending()).toBe(0);
    expect(pinned()).toBe('true');
  });

  it('回到底部后的滚动事件本身也会清零计数', () => {
    const view = render(<Harness ownerKey="run-a" itemCount={1} />);
    const box = installScrollMetrics(screen.getByTestId('scroller'), {
      scrollHeight: 900,
      clientHeight: 200,
    });
    fireEvent.scroll(screen.getByTestId('scroller'));
    view.rerender(<Harness ownerKey="run-a" itemCount={3} />);
    expect(pending()).toBe(2);

    box.scrollTop = 700; // 900 - 700 - 200 = 0，回到底部
    fireEvent.scroll(screen.getByTestId('scroller'));
    expect(pending()).toBe(0);
    expect(pinned()).toBe('true');
  });

  it('换 owner 时未读计数不跨实体继承，且条目数变化不算新事件', () => {
    const view = render(<Harness ownerKey="run-a" itemCount={2} />);
    const box = installScrollMetrics(screen.getByTestId('scroller'), {
      scrollHeight: 900,
      clientHeight: 200,
    });
    fireEvent.scroll(screen.getByTestId('scroller'));
    view.rerender(<Harness ownerKey="run-a" itemCount={9} />);
    expect(pending()).toBe(7);

    // Run B 恰好有更多事件；这不是 A 的未读，也不该被当成新到达。
    view.rerender(<Harness ownerKey="run-b" itemCount={20} />);
    expect(pending()).toBe(0);
    expect(pinned()).toBe('true');
    expect(box.scrollTop).toBe(900);
  });

  it('全量重读导致条目变少时不计数、不抢滚动', () => {
    const view = render(<Harness ownerKey="run-a" itemCount={10} />);
    const box = installScrollMetrics(screen.getByTestId('scroller'), {
      scrollHeight: 900,
      clientHeight: 200,
    });
    box.scrollTop = 50;
    fireEvent.scroll(screen.getByTestId('scroller'));

    view.rerender(<Harness ownerKey="run-a" itemCount={4} />);
    expect(pending()).toBe(0);
    expect(box.scrollTop).toBe(50);

    // 重读后的正常增长仍要被算进未读。
    view.rerender(<Harness ownerKey="run-a" itemCount={6} />);
    expect(pending()).toBe(2);
    expect(box.scrollTop).toBe(50);
  });
});
