import type { WebContents } from 'electron';

/**
 * 真实渲染层的取证。
 *
 * 为什么必须在这里做，而不是在单测里：
 *   - jsdom **不加载也不应用**外部样式表。`styles.contract.test.ts` 断言的是
 *     "样式表里写了什么"，不是"浏览器把它解析成了规则并应用到了元素上"。
 *   - jsdom **没有布局**。`scrollHeight` / `clientHeight` 恒为 0，
 *     所以"滚动容器真的能滚"这件事在单测里只能靠桩来假设。
 *   - `prefers-reduced-motion` 是媒体查询。只有真实浏览器 + CDP 的媒体模拟
 *     才能证明"开了减少动效之后，动画真的变成 0"。
 *
 * 这一层拿到的是**计算样式**与**实际几何**，是阶段审计 §9.3 里第 6、9 两项
 * GUI walkthrough 唯一能自动化的部分。它不替代人眼走查，但把"我写了这条 CSS"
 * 升级成了"这条 CSS 真的生效了"。
 */

export interface RenderProbeResult {
  readonly passes: string[];
  readonly failures: string[];
}

interface ComputedProbe {
  readonly enterAnimationName: string;
  readonly enterAnimationDurationMs: number;
  readonly textFaint: string;
  readonly tintProbe: {
    readonly bg: string;
    readonly border: string;
    readonly fg: string;
  };
  readonly bgPanel: string;
  readonly bgElev: string;
  readonly scrollOverflowY: string | null;
  readonly scrollClientHeight: number;
  readonly focusVisibleRules: number;
  readonly reducedMotionBlocks: number;
  readonly styleSheetRules: number;
  /** 同意勾选框在真实级联下的实测宽度 —— 全局 input{width:100%} 曾把它拉成整行 */
  readonly consentCheckboxWidth: number;
}

/** 在渲染进程里量一次；返回的都是**计算后**的值，不是源文件里的字面量。 */
const PROBE_SCRIPT = `(() => {
  const probe = document.createElement('div');
  probe.className = 'rp-enter';
  probe.style.position = 'fixed';
  probe.style.left = '-9999px';
  document.body.appendChild(probe);
  const enter = getComputedStyle(probe);
  const durationText = enter.animationDuration || '0s';
  const durationMs = durationText.trim().endsWith('ms')
    ? parseFloat(durationText)
    : parseFloat(durationText) * 1000;
  const enterAnimationName = enter.animationName;
  probe.remove();

  const root = getComputedStyle(document.documentElement);
  const scroll = document.querySelector('.chat-scroll');

  let focusVisibleRules = 0;
  let reducedMotionBlocks = 0;
  let styleSheetRules = 0;
  for (const sheet of Array.from(document.styleSheets)) {
    let rules;
    try {
      rules = Array.from(sheet.cssRules || []);
    } catch {
      continue; // 跨源样式表读不到；本地打包产物不会走到这里
    }
    for (const rule of rules) {
      styleSheetRules += 1;
      if (rule.selectorText && rule.selectorText.includes(':focus-visible')) focusVisibleRules += 1;
      if (rule.conditionText && rule.conditionText.includes('prefers-reduced-motion')) {
        reducedMotionBlocks += 1;
      }
    }
  }

  return {
    enterAnimationName,
    enterAnimationDurationMs: durationMs,
    textFaint: root.getPropertyValue('--text-tertiary').trim(),
    tintProbe: (() => {
      // 批 2 的淡底是 color-mix 合成、且百分比本身是 var()。
      // getPropertyValue 只回原样文本，证明不了浏览器算得出来 —— 必须量**计算后**的颜色。
      const el = document.createElement('div');
      el.style.background = 'var(--state-failed-tint-bg)';
      el.style.borderTop = '1px solid var(--state-failed-tint-border)';
      el.style.color = 'var(--state-failed-fg)';
      document.body.appendChild(el);
      const cs = getComputedStyle(el);
      const out = { bg: cs.backgroundColor, border: cs.borderTopColor, fg: cs.color };
      el.remove();
      return out;
    })(),
    bgPanel: root.getPropertyValue('--surface-panel').trim(),
    bgElev: root.getPropertyValue('--surface-raised').trim(),
    scrollOverflowY: scroll ? getComputedStyle(scroll).overflowY : null,
    scrollClientHeight: scroll ? scroll.clientHeight : -1,
    focusVisibleRules,
    reducedMotionBlocks,
    styleSheetRules,
    consentCheckboxWidth: (() => {
      // 出站同意勾选框的宽度是被全局 input { width:100% } 咬过的地方（2026-08-24）：
      // 勾选框盒子被拉成整行、图形悬在行中央、披露文字被挤出容器。
      // jsdom 没有布局，这类破版只有真实引擎里量得出来 —— 注入同 class 的哨兵实测。
      const label = document.createElement('label');
      label.className = 'composer-consent';
      label.style.position = 'fixed';
      label.style.left = '-9999px';
      label.style.width = '800px';
      const box = document.createElement('input');
      box.type = 'checkbox';
      const text = document.createElement('span');
      text.textContent = '哨兵';
      label.appendChild(box);
      label.appendChild(text);
      document.body.appendChild(label);
      const w = box.getBoundingClientRect().width;
      label.remove();
      return w;
    })(),
  };
})()`;

function channelToLinear(channel: number): number {
  return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

/** 计算样式返回的是 `rgb(r, g, b)`，不是源文件里的 hex —— 这里按实际渲染值算对比度。 */
function parseColor(value: string): [number, number, number] | null {
  const rgb = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(value);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  // color-mix(in srgb, …) 的计算值序列化成 `color(srgb r g b)`（0–1 分量），不是 rgb()。
  // 只认 srgb：真出现 display-p3 之类的色域，就该 return null 让调用方失败，而不是当 srgb 硬算。
  const srgb = /^color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(value.trim());
  if (srgb) {
    return [
      Math.round(Number(srgb[1]) * 255),
      Math.round(Number(srgb[2]) * 255),
      Math.round(Number(srgb[3]) * 255),
    ];
  }
  const hex = /^#([0-9a-fA-F]{6})$/.exec(value.trim());
  if (hex) {
    const n = hex[1]!;
    return [parseInt(n.slice(0, 2), 16), parseInt(n.slice(2, 4), 16), parseInt(n.slice(4, 6), 16)];
  }
  return null;
}

function luminance(color: [number, number, number]): number {
  const [r, g, b] = color.map((c) => channelToLinear(c / 255)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number | null {
  const ca = parseColor(a);
  const cb = parseColor(b);
  if (!ca || !cb) return null;
  const la = luminance(ca);
  const lb = luminance(cb);
  const [light, dark] = la > lb ? [la, lb] : [lb, la];
  return (light + 0.05) / (dark + 0.05);
}

async function emulateReducedMotion(webContents: WebContents, reduce: boolean): Promise<void> {
  await webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
    features: [
      {
        name: 'prefers-reduced-motion',
        value: reduce ? 'reduce' : 'no-preference',
      },
    ],
  });
}

/**
 * 跑一遍渲染层取证。
 *
 * 刻意**不**抛异常：CDP 附加失败（无头环境、debugger 已被占用）是环境问题，
 * 应该报成一条明确的失败项，而不是把整个自检炸掉。
 */
export async function probeRenderedStyles(webContents: WebContents): Promise<RenderProbeResult> {
  const passes: string[] = [];
  const failures: string[] = [];

  let attached = false;
  try {
    webContents.debugger.attach('1.3');
    attached = true;
  } catch (err) {
    failures.push(`无法附加 CDP，渲染层取证未执行：${(err as Error).message}`);
    return { passes, failures };
  }

  try {
    await emulateReducedMotion(webContents, false);
    const normal = (await webContents.executeJavaScript(PROBE_SCRIPT)) as ComputedProbe;

    // 0. 样式表真的被解析了 —— 后面每一条都建立在这个前提上。
    if (normal.styleSheetRules > 0) {
      passes.push(
        `样式表已解析为 ${normal.styleSheetRules} 条规则（不是文件文本，是浏览器解析结果）`,
      );
    } else {
      failures.push('渲染进程里一条 CSS 规则都没有，后续样式断言全部无意义');
      return { passes, failures };
    }

    // 1. 入场动效真的挂上了，且时长落在任务书要求的 120–160ms 内。
    if (normal.enterAnimationName.includes('rp-enter')) {
      passes.push(`.rp-enter 计算样式的 animation-name = ${normal.enterAnimationName}`);
    } else {
      failures.push(`.rp-enter 没有生效，animation-name = ${normal.enterAnimationName}`);
    }
    if (normal.enterAnimationDurationMs >= 120 && normal.enterAnimationDurationMs <= 160) {
      passes.push(`入场动效实测 ${normal.enterAnimationDurationMs}ms，在 120–160ms 内`);
    } else {
      failures.push(`入场动效实测 ${normal.enterAnimationDurationMs}ms，超出 120–160ms`);
    }

    // 2. 对比度用**计算后**的颜色算，而不是源文件里的 hex 字面量。
    for (const [label, surface] of [
      ['--surface-panel', normal.bgPanel],
      ['--surface-raised', normal.bgElev],
    ] as const) {
      const ratio = contrastRatio(normal.textFaint, surface);
      if (ratio === null) {
        failures.push(`无法解析计算颜色：--text-faint=${normal.textFaint} ${label}=${surface}`);
      } else if (ratio >= 4.5) {
        passes.push(`--text-faint 在 ${label} 上实测 ${ratio.toFixed(2)}:1`);
      } else {
        failures.push(`--text-faint 在 ${label} 上只有 ${ratio.toFixed(2)}:1，低于 4.5:1`);
      }
    }

    // 3. 焦点环规则真的进了 CSSOM（不只是文件里有这段文本）。
    /*
     * color-mix 一旦不被接受，属性在计算值阶段就无效、背景静默变成透明 —— jsdom 抓不到，
     * 合同测试算的又是我自己的实现。只有真浏览器的计算值能证明这套派生真的生效了。
     */
    const tint = normal.tintProbe;
    // 不透明 = 解析得出且不带 0 alpha。color-mix 被拒时属性无效，背景会落回 transparent /
    // rgba(0, 0, 0, 0)，两者都在这里被判死。
    const opaque = (c: string) => parseColor(c) !== null && !/(,|\/)\s*0\s*\)$/.test(c);
    if (opaque(tint.bg) && opaque(tint.border)) {
      passes.push(`color-mix 淡底真的算出来了：底 ${tint.bg} 边 ${tint.border}`);
      const ratio = contrastRatio(tint.fg, tint.bg);
      if (ratio === null) failures.push(`无法解析淡底对比度：fg=${tint.fg} bg=${tint.bg}`);
      else if (ratio < 4.5) failures.push(`语义色在自己淡底上实测只有 ${ratio.toFixed(2)}:1`);
      else passes.push(`语义色在自己淡底上实测 ${ratio.toFixed(2)}:1`);
    } else {
      failures.push(
        `color-mix 淡底未被浏览器接受：底=${tint.bg} 边=${tint.border}（应为不透明 rgb）`,
      );
    }

    if (normal.focusVisibleRules > 0) {
      passes.push(`:focus-visible 规则已进入 CSSOM，共 ${normal.focusVisibleRules} 条`);
    } else {
      failures.push(':focus-visible 一条规则都没进 CSSOM，键盘焦点环不会出现');
    }

    // 4. 时间线容器真的是个能滚的盒子 —— jsdom 里这两个值恒为 0，只能在这里证。
    if (normal.scrollOverflowY === 'auto' || normal.scrollOverflowY === 'scroll') {
      passes.push(`.chat-scroll 实测 overflow-y=${normal.scrollOverflowY}`);
    } else {
      failures.push(`.chat-scroll 不是滚动容器，overflow-y=${String(normal.scrollOverflowY)}`);
    }
    if (normal.scrollClientHeight > 0) {
      passes.push(
        `.chat-scroll 实测 clientHeight=${normal.scrollClientHeight}px（真实布局，非桩）`,
      );
    } else {
      failures.push(
        `.chat-scroll 的 clientHeight=${normal.scrollClientHeight}，跟随逻辑没有可用几何`,
      );
    }

    // 4.5 同意勾选框必须是内容宽 —— 全局 input{width:100%} 的级联回归在这里守
    if (normal.consentCheckboxWidth > 0 && normal.consentCheckboxWidth <= 40) {
      passes.push(
        `同意勾选框实测宽度 ${normal.consentCheckboxWidth.toFixed(1)}px（未被全局 input 宽度规则拉伸）`,
      );
    } else {
      failures.push(
        `同意勾选框实测宽度 ${normal.consentCheckboxWidth.toFixed(1)}px —— ` +
          `全局 input { width:100% } 又咬到它了：勾选框会悬在行中央、披露文字被挤出容器`,
      );
    }

    // 5. 开启 Reduce Motion 后，非必要运动必须真的消失。
    if (normal.reducedMotionBlocks > 0) {
      passes.push(`prefers-reduced-motion 媒体块已进入 CSSOM，共 ${normal.reducedMotionBlocks} 个`);
    } else {
      failures.push('没有任何 prefers-reduced-motion 媒体块进入 CSSOM');
    }

    await emulateReducedMotion(webContents, true);
    const reduced = (await webContents.executeJavaScript(PROBE_SCRIPT)) as ComputedProbe;
    if (reduced.enterAnimationDurationMs <= 1) {
      passes.push(
        `Reduce Motion 下入场动效实测 ${reduced.enterAnimationDurationMs}ms（媒体模拟真实生效）`,
      );
    } else {
      failures.push(
        `Reduce Motion 下入场动效仍有 ${reduced.enterAnimationDurationMs}ms，非必要运动没有被关掉`,
      );
    }
    // 布局事实不能因为关动效而改变。
    if (reduced.scrollClientHeight === normal.scrollClientHeight) {
      passes.push('Reduce Motion 前后 .chat-scroll 几何不变，动效没有参与布局');
    } else {
      failures.push(
        `Reduce Motion 改变了布局：clientHeight ${normal.scrollClientHeight} → ${reduced.scrollClientHeight}`,
      );
    }

    await emulateReducedMotion(webContents, false);
  } catch (err) {
    failures.push(`渲染层取证中断：${(err as Error).message}`);
  } finally {
    if (attached) {
      try {
        webContents.debugger.detach();
      } catch {
        // 窗口已经在关闭途中；detach 失败不影响已经取到的证据。
      }
    }
  }

  return { passes, failures };
}
