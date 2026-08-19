import { useCallback, useLayoutEffect, useRef, useState } from 'react';

/**
 * 距底部多少像素以内，仍然算作「用户在看最新的内容」。
 *
 * 阈值存在的原因是滚动位置不是整数事实：字体行高、边距和亚像素滚动都会让
 * `scrollTop + clientHeight` 差几像素够不到 `scrollHeight`。没有阈值的话，
 * 用户明明停在底部也会被判成「正在往回读」，于是永远看不到自动跟随。
 */
export const FOLLOW_THRESHOLD_PX = 64;

export interface StickToBottom<E extends HTMLElement> {
  /** 挂到滚动容器上的 callback ref；节点换了会重新绑定监听。 */
  readonly containerRef: (element: E | null) => void;
  /** 用户当前是否在底部阈值内。 */
  readonly pinned: boolean;
  /** 离底期间累积的新条目数；回到底部或跳转后清零。 */
  readonly pendingCount: number;
  /** 跳到底部并清零计数；键盘与鼠标共用这一个入口。 */
  readonly jumpToBottom: () => void;
}

/**
 * 「跟随最新内容，但不抢用户的滚动位置」。
 *
 * 两条规则构成全部语义：
 *   1. 用户在底部阈值内 → 新条目到达时把视口拉到底；
 *   2. 用户往回读 → **绝不**移动 scrollTop，只累计「有多少条没看到」。
 *
 * 计数用的是 durable 条目数量，不是动画帧或估算进度：它必须能对应到时间线上
 * 真实存在的行，否则这个数字就是装饰。owner 变化（换 Run、进设置页）时整组
 * 状态重置并回到底部 —— 新实体没有「未读」，旧实体的未读也不能带过去。
 */
export function useStickToBottom<E extends HTMLElement>({
  ownerKey,
  itemCount,
  thresholdPx = FOLLOW_THRESHOLD_PX,
}: {
  ownerKey: string | null;
  itemCount: number;
  thresholdPx?: number;
}): StickToBottom<E> {
  const nodeRef = useRef<E | null>(null);
  const detachRef = useRef<(() => void) | null>(null);
  const pinnedRef = useRef(true);
  const lastCountRef = useRef(itemCount);
  const ownerRef = useRef<string | null>(ownerKey);
  const thresholdRef = useRef(thresholdPx);
  thresholdRef.current = thresholdPx;

  const [pinned, setPinned] = useState(true);
  const [pendingCount, setPendingCount] = useState(0);

  const scrollToBottom = useCallback(() => {
    const element = nodeRef.current;
    if (!element) return;
    /*
     * 刻意不用 smooth：容器里若有未结束的平滑滚动，Chromium 会静默吞掉这次调用
     * （与 ApprovalDock 的跳转同一个理由）。跟随的意义是"一定能看到最新"，
     * 可靠性优先于顺滑。
     */
    element.scrollTop = element.scrollHeight;
  }, []);

  const syncFromScroll = useCallback(() => {
    const element = nodeRef.current;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    const next = distance <= thresholdRef.current;
    pinnedRef.current = next;
    setPinned(next);
    // 回到底部即视为已读完；计数不能停留在一个用户已经看过的数字上。
    if (next) setPendingCount(0);
  }, []);

  const containerRef = useCallback(
    (element: E | null) => {
      detachRef.current?.();
      detachRef.current = null;
      nodeRef.current = element;
      if (!element) return;
      const onScroll = () => syncFromScroll();
      element.addEventListener('scroll', onScroll, { passive: true });
      detachRef.current = () => element.removeEventListener('scroll', onScroll);
      // 新容器一挂上就以它自己的位置为准，不继承上一个节点的判断。
      syncFromScroll();
    },
    [syncFromScroll],
  );

  const jumpToBottom = useCallback(() => {
    scrollToBottom();
    pinnedRef.current = true;
    setPinned(true);
    setPendingCount(0);
  }, [scrollToBottom]);

  // owner 重置必须排在增量之前：换 Run 后条目数的变化不是"新事件"。
  useLayoutEffect(() => {
    if (ownerRef.current === ownerKey) return;
    ownerRef.current = ownerKey;
    lastCountRef.current = itemCount;
    pinnedRef.current = true;
    setPinned(true);
    setPendingCount(0);
    scrollToBottom();
  }, [itemCount, ownerKey, scrollToBottom]);

  useLayoutEffect(() => {
    const previous = lastCountRef.current;
    if (itemCount === previous) return;
    lastCountRef.current = itemCount;
    // 变短只可能来自一次全量重读；那不是"新事件到达"，不该计数也不该抢滚动。
    if (itemCount < previous) return;
    if (pinnedRef.current) {
      scrollToBottom();
      return;
    }
    setPendingCount((count) => count + (itemCount - previous));
  }, [itemCount, scrollToBottom]);

  useLayoutEffect(
    () => () => {
      detachRef.current?.();
      detachRef.current = null;
    },
    [],
  );

  return { containerRef, pinned, pendingCount, jumpToBottom };
}
