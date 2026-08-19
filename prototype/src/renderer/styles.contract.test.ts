import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 样式表合同测试。
 *
 * 边界要说清楚：jsdom 不加载也不应用外部样式表，所以这里断言的是
 * **样式表声明了什么**，不是"某个浏览器真的这样渲染了"。对比度是真算出来的，
 * 动效时长和 reduced-motion 分支是真解析出来的；渲染层的证据只能来自 GUI walkthrough。
 */
const css = readFileSync(fileURLToPath(new URL('./styles.css', import.meta.url)), 'utf8');

function hexToLinear(hex: string): [number, number, number] {
  const value = hex.replace('#', '');
  const channels = [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16) / 255);
  return channels.map((c) =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
  ) as [number, number, number];
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToLinear(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [light, dark] = la > lb ? [la, lb] : [lb, la];
  return (light + 0.05) / (dark + 0.05);
}

/**
 * 解析一个自定义属性到最终字面值，穿透 `var(--x)` 链。
 * 批 0 起旧名只是第 2 层角色的别名（`--text-faint: var(--text-tertiary)`），
 * 只认字面 hex 的老写法会在这里直接抛错。链深上限 8：token 分三层，超过就是写错了。
 */
function token(name: string, depth = 0): string {
  if (depth > 8) throw new Error(`token --${name}: var() 链过深，疑似循环引用`);
  const match = new RegExp(`--${name}:\\s*([^;]+);`).exec(css);
  if (!match) throw new Error(`token --${name} not found`);
  const raw = match[1]!.trim();
  const ref = /^var\(--([a-z0-9-]+)\)$/.exec(raw);
  return ref ? token(ref[1]!, depth + 1) : raw;
}

/**
 * 换皮之后的锚点。值来自 design-baseline-v1.0-frozen.md v1.1「warm 色板」表。
 *
 * 这张表的用处不是"防止有人改颜色"（换色本来就该改），是**防止有人只改一半**：
 * warm 一旦落地，任何还留着 cool 值的角色都会在这里当场炸出来。
 * 偏离基线的两个值（ink-3、accent 独立）在 styles.css 里各写了理由。
 */
const WARM_LITERALS: Record<string, string> = {
  'surface-canvas': '#110f0d',
  'surface-panel': '#201d1a',
  'surface-raised': '#302c28',
  'border-hairline': '#2b2723',
  'text-primary': '#ede8e1',
  'text-secondary': '#b3aaa0',
  // 基线是 #928a80（raised 上 4.07）；朝 ink-1 提亮 10% 让它在 raised 上过 4.5。
  'text-tertiary': '#9b938a',
  'accent-interactive': '#c97a5b',
  'state-verified-fg': '#6dbe93',
  'state-warning-fg': '#c9a05f',
  'state-failed-fg': '#ed8b93',
  'state-blocked-fg': '#77a9da',
  'state-unknown-fg': '#a991d6',
  'state-stale-fg': '#bfa093',
  'font-mono': "ui-monospace, 'SF Mono', Menlo, Monaco, monospace",
};

/**
 * 解析 `color-mix(in srgb, <c1> <p>, <c2>)` 到字面 hex。
 *
 * 批 2 起淡底与淡边是 color-mix 实时合成的（而不是预算好的字面值）——
 * 换色板时它们必须自动跟着走，否则派生值会集体过期，变成下一批硬编码。
 * 代价是合同测试得自己算一遍：门禁要的是**合成后**的值。
 */
function mixSrgb(expr: string, depth = 0): string {
  // 百分比本身可能是 var(--palette-tint-alpha-bg) —— α 是第 1 层参数，换色板要能一起改
  const m = /^color-mix\(\s*in srgb\s*,\s*(.+?)\s+((?:[\d.]+%)|(?:var\(--[a-z0-9-]+\)))\s*,\s*(.+?)\s*\)$/.exec(
    expr.trim(),
  );
  if (!m) return expr;
  const pctRaw = m[2]!.startsWith('var(') ? rawToken(/var\(--([a-z0-9-]+)\)/.exec(m[2]!)![1]!) : m[2]!;
  const a = Number(pctRaw.replace('%', '')) / 100;
  if (!Number.isFinite(a)) return expr;
  const c1 = resolveColor(m[1]!, depth + 1);
  const c2 = m[3]!.trim() === 'transparent' ? '#000000' : resolveColor(m[3]!, depth + 1);
  if (!/^#[0-9a-fA-F]{6}$/.test(c1) || !/^#[0-9a-fA-F]{6}$/.test(c2)) return expr;
  const ch = (h: string, i: number) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
  const out = [0, 1, 2]
    .map((i) => Math.round(ch(c1, i) * a + ch(c2, i) * (1 - a)))
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');
  return `#${out}`;
}

/** token 名或字面值 → 字面 hex（穿透 var() 链与 color-mix）。 */
function resolveColor(raw: string, depth = 0): string {
  if (depth > 8) throw new Error(`解析 ${raw} 时层数过深`);
  const t = raw.trim();
  const ref = /^var\(--([a-z0-9-]+)\)$/.exec(t);
  if (ref) return resolveColor(rawToken(ref[1]!), depth + 1);
  if (t.startsWith('color-mix(')) return mixSrgb(t, depth);
  return t;
}

function rawToken(name: string): string {
  const m = new RegExp(`--${name}:\\s*([^;]+);`).exec(css);
  if (!m) throw new Error(`token --${name} not found`);
  return m[1]!.trim();
}

/**
 * 已退役的名字 —— 任何一个复活都意味着有人绕过了角色层或绕过了派生规则。
 * 前 13 个是批 1 删掉的旧别名；后 5 个是换 warm 时被派生规则取代的手挑值。
 */
const RETIRED_ALIASES = [
  'bg', 'bg-panel', 'bg-elev', 'border', 'text', 'text-dim', 'text-faint',
  'accent', 'ok', 'warn', 'err', 'purple', 'mono',
  'palette-green-strong', 'palette-amber-strong', 'palette-red-strong',
  'palette-blue-strong', 'palette-blue-soft',
];

describe('三层 token：角色层是唯一入口，换皮只动第 1 层', () => {
  it('角色名穿透 var() 链后等于基线 v1.1 的 warm 值', () => {
    for (const [name, literal] of Object.entries(WARM_LITERALS)) {
      expect(token(name), `--${name}`).toBe(literal);
    }
  });

  it('批 1 删掉的 13 个旧名不得复活（复活=有人绕过角色层）', () => {
    for (const name of RETIRED_ALIASES) {
      expect(new RegExp(`--${name}:`).test(css), `--${name} 已在批 1 退役`).toBe(false);
      expect(css.includes(`var(--${name})`), `var(--${name}) 已在批 1 退役`).toBe(false);
    }
  });

  it('组件层只引用第 2 层角色，绝不直达第 1 层 palette', () => {
    const body = css.replace(/:root\s*\{[\s\S]*?\n\}/, '');
    const direct = [...body.matchAll(/var\(--palette-[a-z0-9-]+\)/g)].map((m) => m[0]);
    expect(direct, '组件层出现了对第 1 层的直接引用').toEqual([]);
  });

  it('第 2 层角色只引用第 1 层，第 1 层只持有字面值', () => {
    const root = /:root\s*\{([\s\S]*?)\n\}/.exec(css)![1]!;
    const decls = [...root.matchAll(/^\s*--([a-z0-9-]+):\s*([^;]+);/gm)].map((m) => [m[1]!, m[2]!.trim()] as const);
    const roles = decls.filter(([n]) => /^(surface|border|text|accent|focus|state|font)-/.test(n));
    const palette = decls.filter(([n]) => n.startsWith('palette-'));
    expect(roles.length).toBeGreaterThanOrEqual(20);
    for (const [n, v] of roles) {
      if (n === 'font-mono') continue; // 字体栈是字面值角色，没有第 1 层
      if (n.startsWith('shadow-')) continue; // 阴影是几何+黑，与色板无关
      // 合成角色（淡底/淡边）由别的角色 color-mix 而来 —— 仍然不含字面值
      if (v.startsWith('color-mix(')) {
        expect(v, `--${n} 的 color-mix 里不许出现字面色`).not.toMatch(/#[0-9a-fA-F]{3,8}/);
        continue;
      }
      expect(v, `--${n} 必须引用 --palette-* 或由角色 color-mix 而来`).toMatch(/^var\(--/);
    }
    for (const [n, v] of palette) {
      expect(v, `--${n} 必须是字面值`).not.toMatch(/var\(/);
    }
  });
});

describe('批 2 · 淡底是合成出来的，合成后的值也要过门禁', () => {
  const SEMANTICS = ['verified', 'warning', 'failed', 'blocked', 'unknown'] as const;

  it('五个语义淡底都能被解析成字面 hex（color-mix 没写坏）', () => {
    for (const s of SEMANTICS) {
      for (const kind of ['bg', 'border']) {
        const v = resolveColor(`var(--state-${s}-tint-${kind})`);
        expect(v, `--state-${s}-tint-${kind}`).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });

  it('语义色作为正文放在自己的淡底上仍达 4.5:1', () => {
    // 这条是选 canvas 作淡底基底的**原因**：以 panel 为底、α=14% 时
    // failed / unknown 只有 4.44 / 4.34，批 2 会引入一次无障碍回归。
    for (const s of SEMANTICS) {
      const fg = resolveColor(`var(--state-${s}-fg)`);
      const bg = resolveColor(`var(--state-${s}-tint-bg)`);
      const ratio = contrastRatio(fg, bg);
      expect(ratio, `--state-${s}-fg (${fg}) 在自己的淡底 ${bg} 上只有 ${ratio.toFixed(2)}:1`)
        .toBeGreaterThanOrEqual(4.5);
    }
  });

  it('亮变体与主文字在淡底上同样达标', () => {
    for (const s of ['verified', 'warning', 'failed', 'blocked', 'unknown'] as const) {
      const bg = resolveColor(`var(--state-${s}-tint-bg)`);
      expect(contrastRatio(resolveColor(`var(--state-${s}-fg-strong)`), bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(resolveColor('var(--text-primary)'), bg)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('划界的是淡边不是淡底：淡边对 panel 与对自己淡底都要能分辨', () => {
    /*
     * 门槛定在 1.25，依据是**改之前的实测**：手挑淡边对 panel 是 1.307–1.398。
     * 一开始我给淡底设了 ≥1.05，结果发现现有手挑底对 panel 只有 1.003–1.038 ——
     * 那条门槛从来没成立过。徽章/横幅是靠边框划界的，底只是很淡的一层色。
     * 对不存在的性质设门槛，只会逼着后来的人把门槛调低，而不是把东西做对。
     */
    const panel = resolveColor('var(--surface-panel)');
    for (const s of SEMANTICS) {
      const border = resolveColor(`var(--state-${s}-tint-border)`);
      const bg = resolveColor(`var(--state-${s}-tint-bg)`);
      expect(contrastRatio(border, panel), `--state-${s}-tint-border 对 panel`).toBeGreaterThanOrEqual(1.25);
      expect(contrastRatio(border, bg), `--state-${s}-tint-border 对自己的淡底`).toBeGreaterThanOrEqual(1.25);
    }
  });

  it('代码面与代码字：终端块比 canvas 更深，字够亮', () => {
    const code = resolveColor('var(--surface-code)');
    expect(contrastRatio(resolveColor('var(--text-code)'), code)).toBeGreaterThanOrEqual(4.5);
  });

  it('实心底上的字：accent 与语义实心底都达标', () => {
    expect(
      contrastRatio(resolveColor('var(--accent-fg-on-accent)'), resolveColor('var(--accent-interactive)')),
    ).toBeGreaterThanOrEqual(4.5);
  });
});

describe('样式表合同：对比度、动效时长与 reduced-motion', () => {
  it('三级文字对三种底色都达到 4.5:1', () => {
    const faint = token('text-tertiary');
    for (const surface of ['surface-canvas', 'surface-panel', 'surface-raised']) {
      const ratio = contrastRatio(faint, token(surface));
      expect(
        ratio,
        `--text-tertiary (${faint}) 在 --${surface} 上只有 ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('主要与次要文字同样达标，层级不靠把字压暗到读不动', () => {
    for (const name of ['text-primary', 'text-secondary']) {
      expect(contrastRatio(token(name), token('surface-panel'))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('入场动效落在 120–160ms 区间内', () => {
    const durations = [...css.matchAll(/animation:\s*rp-enter\s+(\d+)ms/g)].map((m) =>
      Number(m[1]),
    );
    expect(durations.length).toBeGreaterThan(0);
    for (const ms of durations) {
      expect(ms).toBeGreaterThanOrEqual(120);
      expect(ms).toBeLessThanOrEqual(160);
    }
  });

  it('入场动效只改 opacity 与 transform，不改变布局属性', () => {
    const keyframes = /@keyframes rp-enter\s*\{([\s\S]*?)\n\}/.exec(css);
    expect(keyframes).not.toBeNull();
    const properties = [...keyframes![1]!.matchAll(/^\s*([a-z-]+):/gm)].map((m) => m[1]);
    // height / margin / padding / top 之类会推动周围内容 —— 动效不许改变布局事实。
    expect([...new Set(properties)].sort()).toEqual(['opacity', 'transform']);
  });

  it('prefers-reduced-motion 下关闭非必要运动，且覆盖 rp-enter', () => {
    const blocks = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\)\s*\{/g)];
    expect(blocks.length).toBeGreaterThan(0);
    const reduced = css.slice(blocks[0]!.index);
    expect(reduced).toMatch(/\.rp-enter\s*\{\s*animation:\s*none/);
    expect(reduced).toMatch(/animation-duration:\s*0\.001ms\s*!important/);
    expect(reduced).toMatch(/transition-duration:\s*0\.001ms\s*!important/);
  });

  it('键盘焦点有统一的 :focus-visible 环，不是到处 outline: none', () => {
    // 批 1 起焦点环走它自己的角色 --focus-ring；warm 之后它绑的是 accent（铜）
    expect(css).toMatch(/:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--focus-ring\)/);
    // 旧的 input:focus { outline: none } 仍在，但必须有 :focus-visible 兜底。
    expect(css).toMatch(/input:focus-visible/);
  });
});

describe('换 warm 之后新增的两条：accent 独立、淡底正文按 AAA 倒推', () => {
  const SEMANTICS = ['verified', 'warning', 'failed', 'blocked', 'unknown'] as const;

  it('accent 与 blocked 不再同源', () => {
    // v1.0 §2.1 让它们共用一个蓝；v1.1 把 accent × 六语义色的 ΔE₀₀ 写进门禁，
    // 同源等于 ΔE=0，必挂。分开之后"轮到你"由形状轴和闸门位置承担。
    expect(token('accent-interactive')).not.toBe(token('state-blocked-fg'));
    expect(token('focus-ring')).toBe(token('accent-interactive'));
  });

  it('五个语义都有 -fg-strong，且都由同一条派生规则算出来', () => {
    for (const name of SEMANTICS) {
      const raw = rawToken(`state-${name}-fg-strong`);
      // 手挑值会是 var(--palette-…) 或裸 hex；派生值必须是 color-mix 且引用同一个 α。
      expect(raw, `--state-${name}-fg-strong)`).toContain('color-mix(in srgb');
      expect(raw, `--state-${name}-fg-strong)`).toContain('var(--palette-tint-text-alpha)');
      expect(raw, `--state-${name}-fg-strong)`).toContain(`var(--state-${name}-fg)`);
    }
  });

  it('淡底上的正文全部达到 WCAG AAA 7.0（这个门槛就是 α 的来源）', () => {
    // 85% 不是挑的：它是"五个语义在自己淡底上全部 ≥7.0"能过的最大整档 α。
    // 门槛在这里，α 在 styles.css 里 —— 改 α 而不看这条测试，就会当场红。
    for (const name of SEMANTICS) {
      const ratio = contrastRatio(resolveColor(`var(--state-${name}-fg-strong)`), resolveColor(`var(--state-${name}-tint-bg)`));
      expect(ratio, `--state-${name}-fg-strong 在自己淡底上`).toBeGreaterThanOrEqual(7);
    }
  });

  it('三级字在 raised 上仍达 4.5 —— 基线的 warm tertiary 在这里是不够的', () => {
    // 基线 #928a80 在 raised 上只有 4.07，它靠"禁入 raised"这条用法规则兜。
    // 组件今天确实把三级字放在 raised 上，所以改的是颜色不是门槛。
    const tertiary = resolveColor('var(--text-tertiary)');
    for (const surface of ['surface-canvas', 'surface-panel', 'surface-raised']) {
      expect(contrastRatio(tertiary, resolveColor(`var(--${surface})`)), `三级字在 --${surface} 上`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
