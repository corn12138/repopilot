import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ObserverPushEvent } from '@shared/observerProtocol';
import {
  ObserverError,
  ObserverService,
  mungeClaudeProjectDir,
  projectionLineOf,
  readCodexSessionCwd,
} from './observerService';

/**
 * 服务层测试的取材纪律：正文行走**基线不认识的 type**（未知 type 不定罪，投影仍 OK），
 * 降级用例走**基线认识但缺必现键**的记录 —— 这样断言不与已提交基线的具体键集耦合，
 * 基线重生成后测试依然成立（只假设基线认识 claude 的 `user` 且必现键不止 `type`）。
 */

const j = (o: unknown): string => JSON.stringify(o);
const PROJECT = '/work/demo-project';

let root = '';
let claudeRoot = '';
let codexRoot = '';
let events: ObserverPushEvent[] = [];
let service: ObserverService;
let nowMs = 1_700_000_000_000;

function claudeDirOf(project: string): string {
  return join(claudeRoot, mungeClaudeProjectDir(project));
}

function writeClaudeSession(name: string, lines: string[], mtimeSec: number): string {
  const dir = claudeDirOf(PROJECT);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, `${lines.join('\n')}\n`);
  utimesSync(p, mtimeSec, mtimeSec);
  return p;
}

function writeCodexRollout(name: string, cwd: string | null, extraLines: string[] = []): string {
  const dir = join(codexRoot, '2026', '09', '02');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  const head =
    cwd === null
      ? 'not-json-at-all'
      : j({ timestamp: 't', type: 'session_meta', payload: { id: 'x', cwd } });
  writeFileSync(p, `${[head, ...extraLines].join('\n')}\n`);
  return p;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'repopilot-observer-test-'));
  claudeRoot = join(root, 'claude-projects');
  codexRoot = join(root, 'codex-sessions');
  mkdirSync(claudeRoot, { recursive: true });
  mkdirSync(codexRoot, { recursive: true });
  events = [];
  service = new ObserverService({
    claudeProjectsRoot: claudeRoot,
    codexSessionsRoot: codexRoot,
    emit: (e) => events.push(e),
    now: () => nowMs,
  });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('授权与会话发现', () => {
  it('未授权时 listSessions/watch 一律 NOT_GRANTED —— 不是空列表，是拒绝', () => {
    expect(() => service.listSessions()).toThrow(ObserverError);
    expect(() => service.watch('CLAUDE_JOURNAL:x.jsonl')).toThrow(/尚未授权/);
    expect(service.status()).toEqual({ granted: null, watching: [] });
  });

  it('enable 后按项目发现两家会话：claude 走 munge 目录、codex 按首行 cwd 过滤；条目不带宿主路径', () => {
    writeClaudeSession('aaa.jsonl', [j({ type: 'spec-line' })], 1_000);
    writeClaudeSession('bbb.jsonl', [j({ type: 'spec-line' })], 2_000);
    writeCodexRollout('rollout-match.jsonl', PROJECT);
    writeCodexRollout('rollout-other.jsonl', '/somewhere/else');
    writeCodexRollout('rollout-broken.jsonl', null);

    const { sessions, counts } = service.enable(PROJECT, '~/demo-project');
    // sessionId = vendor + 相对扫描根的路径：claude 相对项目目录，codex 相对 sessions 根
    expect(sessions.map((s) => s.sessionId).sort()).toEqual([
      'CLAUDE_JOURNAL:aaa.jsonl',
      'CLAUDE_JOURNAL:bbb.jsonl',
      'CODEX_ROLLOUT:2026/09/02/rollout-match.jsonl',
    ]);
    expect(counts.claudeMatched).toBe(2);
    expect(counts.codexScanned).toBe(3);
    expect(counts.codexMatched).toBe(1);
    expect(counts.codexUnreadable).toBe(1);
    for (const s of sessions) expect(Object.keys(s)).not.toContain('path');
    expect(service.status().granted).toBe('~/demo-project');
    // enable 推送了状态事件
    expect(events.some((e) => e.kind === 'observer.state' && e.state.granted === '~/demo-project')).toBe(true);
  });

  it('目标项目没有任何日志目录 → 空列表 + 计数为零，不抛', () => {
    const { sessions, counts } = service.enable('/no/such/project', '/no/such/project');
    expect(sessions).toEqual([]);
    expect(counts.claudeMatched).toBe(0);
    expect(counts.codexMatched).toBe(0);
  });
});

describe('监视与投影', () => {
  it('watch 未知会话 → UNKNOWN_SESSION', () => {
    service.enable(PROJECT, PROJECT);
    expect(() => service.watch('CLAUDE_JOURNAL:ghost.jsonl')).toThrow(/未知会话/);
  });

  it('watch 立即出一份投影；文件不变不重推；追加后再推', () => {
    const p = writeClaudeSession(
      'live.jsonl',
      [j({ type: 'spec-line', n: 1 }), j({ type: 'spec-line', n: 2 })],
      1_000,
    );
    service.enable(PROJECT, PROJECT);
    service.watch('CLAUDE_JOURNAL:live.jsonl');

    const first = events.filter((e) => e.kind === 'observer.projection');
    expect(first.length).toBe(1);
    const proj0 = first[0]!.kind === 'observer.projection' ? first[0]!.projection : null;
    expect(proj0?.status).toBe('OK');
    expect(proj0?.counts.records).toBe(2);
    // 连续同类标签行折叠成一行 ×2
    expect(proj0?.lines).toEqual([{ seq: 0, kind: '[spec-line]', text: '', collapsed: 2 }]);

    service.pollOnce();
    expect(events.filter((e) => e.kind === 'observer.projection').length).toBe(1);

    writeFileSync(p, `${[j({ type: 'spec-line', n: 1 }), j({ type: 'other-line' })].join('\n')}\n`);
    utimesSync(p, 3_000, 3_000);
    service.pollOnce();
    const all = events.filter((e) => e.kind === 'observer.projection');
    expect(all.length).toBe(2);
  });

  it('违反消费契约（user 无 message 对象）→ FORMAT_UNKNOWN：正文清空、违规明细可见、计数保留', () => {
    writeClaudeSession('bad.jsonl', [j({ type: 'user' })], 1_000);
    service.enable(PROJECT, PROJECT);
    service.watch('CLAUDE_JOURNAL:bad.jsonl');
    const ev = events.find((e) => e.kind === 'observer.projection');
    const proj = ev?.kind === 'observer.projection' ? ev.projection : null;
    expect(proj?.status).toBe('FORMAT_UNKNOWN');
    expect(proj?.breaking).toEqual(['consumed:user.message 不是对象']);
    expect(proj?.lines).toEqual([]);
    expect(proj?.counts.records).toBe(1);
  });

  it('只与基线有出入、消费键完好 → 状态 OK、正文照常、出入进 driftNotes（2026-09-05 误报的修正）', () => {
    // 基线认识 assistant 且必现键远不止这两个；面板只需要 type + message.content
    writeClaudeSession('drift.jsonl', [j({ type: 'assistant', message: { content: 'hi' } })], 1_000);
    service.enable(PROJECT, PROJECT);
    service.watch('CLAUDE_JOURNAL:drift.jsonl');
    const ev = events.find((e) => e.kind === 'observer.projection');
    const proj = ev?.kind === 'observer.projection' ? ev.projection : null;
    expect(proj?.status).toBe('OK');
    expect(proj?.breaking).toEqual([]);
    expect(proj?.lines).toEqual([{ seq: 0, kind: 'assistant', text: 'hi', collapsed: 1 }]);
    expect(proj?.driftNotes.length).toBeGreaterThan(0);
    expect(proj?.driftNotes.every((d) => d.startsWith('top:assistant.'))).toBe(true);
  });

  it('消费契约的另两类违规：codex payload 非对象；claude content 既非字符串也非数组', () => {
    writeClaudeSession('c1.jsonl', [j({ type: 'assistant', message: { content: 42 } })], 1_000);
    writeCodexRollout('rollout-c2.jsonl', PROJECT, [j({ type: 'response_item', payload: 'nope' })]);
    service.enable(PROJECT, PROJECT);
    service.watch('CLAUDE_JOURNAL:c1.jsonl');
    let ev = events.findLast((e) => e.kind === 'observer.projection');
    expect(ev?.kind === 'observer.projection' && ev.projection.breaking).toEqual([
      'consumed:assistant.message.content 既不是字符串也不是数组',
    ]);
    service.watch('CODEX_ROLLOUT:2026/09/02/rollout-c2.jsonl');
    ev = events.findLast((e) => e.kind === 'observer.projection');
    expect(ev?.kind === 'observer.projection' && ev.projection.breaking).toEqual(['consumed:payload 不是对象']);
  });

  it('claude 只列顶层会话：subagents/ 与各会话的 journal.jsonl 不进列表但计数；同名不再互相覆盖', () => {
    const dir = claudeDirOf(PROJECT);
    mkdirSync(join(dir, 'sess-a', 'subagents'), { recursive: true });
    mkdirSync(join(dir, 'sess-b'), { recursive: true });
    writeFileSync(join(dir, 'sess-a.jsonl'), `${j({ type: 'spec' })}\n`);
    writeFileSync(join(dir, 'sess-a', 'subagents', 'agent-1.jsonl'), `${j({ type: 'spec' })}\n`);
    writeFileSync(join(dir, 'sess-a', 'journal.jsonl'), `${j({ type: 'spec' })}\n`);
    writeFileSync(join(dir, 'sess-b', 'journal.jsonl'), `${j({ type: 'spec' })}\n`);
    const { sessions, counts } = service.enable(PROJECT, PROJECT);
    expect(sessions.map((s) => s.sessionId)).toEqual(['CLAUDE_JOURNAL:sess-a.jsonl']);
    expect(counts.claudeMatched).toBe(1);
    expect(counts.claudeNestedSkipped).toBe(3);
  });

  it('坏行/空行计数如实，且不影响其余记录的投影', () => {
    writeClaudeSession('mixed.jsonl', ['{oops', '', j({ type: 'spec-line' })], 1_000);
    service.enable(PROJECT, PROJECT);
    service.watch('CLAUDE_JOURNAL:mixed.jsonl');
    const ev = events.find((e) => e.kind === 'observer.projection');
    const proj = ev?.kind === 'observer.projection' ? ev.projection : null;
    expect(proj?.counts.unparseableLines).toBe(1);
    // 显式空行 1 + 文件收尾换行产生的尾空行 1 —— 计数忠于 split 结果
    expect(proj?.counts.blankLines).toBe(2);
    expect(proj?.counts.records).toBe(1);
  });

  it('活跃徽标是纯 mtime 启发式：窗口内 true，窗口外 false', () => {
    nowMs = 10_000_000;
    writeClaudeSession('warm.jsonl', [j({ type: 'spec-line' })], 9_995); // 5s 前
    service.enable(PROJECT, PROJECT);
    service.watch('CLAUDE_JOURNAL:warm.jsonl');
    const warm = events.findLast((e) => e.kind === 'observer.projection');
    expect(warm?.kind === 'observer.projection' && warm.projection.active).toBe(true);

    nowMs = 10_000_000 + 60_000;
    const p = claudeDirOf(PROJECT);
    utimesSync(join(p, 'warm.jsonl'), 9_996, 9_996); // mtime 变了才会重读
    service.pollOnce();
    const cold = events.findLast((e) => e.kind === 'observer.projection');
    expect(cold?.kind === 'observer.projection' && cold.projection.active).toBe(false);
  });
});

describe('撤销即清除', () => {
  it('disable 后：状态清空、pollOnce 静默、空状态事件已推送', () => {
    writeClaudeSession('s.jsonl', [j({ type: 'spec-line' })], 1_000);
    service.enable(PROJECT, PROJECT);
    service.watch('CLAUDE_JOURNAL:s.jsonl');
    events = [];

    service.disable();
    expect(service.status()).toEqual({ granted: null, watching: [] });
    expect(events).toEqual([{ kind: 'observer.state', state: { granted: null, watching: [] } }]);

    events = [];
    service.pollOnce();
    expect(events).toEqual([]);
    expect(() => service.listSessions()).toThrow(ObserverError);
  });
});

describe('多镜像槽（OBSERVER_MAX_MIRRORS = 2）', () => {
  it('两个会话各出投影；第三个顶掉最早的；状态推送带有序 watching；重复 watch 幂等', () => {
    writeClaudeSession('a.jsonl', [j({ type: 'a' })], 1_000);
    writeClaudeSession('b.jsonl', [j({ type: 'b' })], 2_000);
    writeClaudeSession('c.jsonl', [j({ type: 'c' })], 3_000);
    service.enable(PROJECT, PROJECT);
    events = [];

    service.watch('CLAUDE_JOURNAL:a.jsonl');
    service.watch('CLAUDE_JOURNAL:b.jsonl');
    expect(service.status().watching).toEqual(['CLAUDE_JOURNAL:a.jsonl', 'CLAUDE_JOURNAL:b.jsonl']);
    const projected = () =>
      events
        .filter((e) => e.kind === 'observer.projection')
        .map((e) => (e.kind === 'observer.projection' ? e.projection.sessionId : ''));
    expect(projected()).toEqual(['CLAUDE_JOURNAL:a.jsonl', 'CLAUDE_JOURNAL:b.jsonl']);

    // 状态推送先于投影：Renderer 先知道槽位序
    expect(events.slice(0, 2).map((e) => e.kind)).toEqual(['observer.state', 'observer.projection']);

    service.watch('CLAUDE_JOURNAL:b.jsonl'); // 幂等：不重推
    expect(projected().length).toBe(2);

    service.watch('CLAUDE_JOURNAL:c.jsonl'); // 满槛：a 被顶掉
    expect(service.status().watching).toEqual(['CLAUDE_JOURNAL:b.jsonl', 'CLAUDE_JOURNAL:c.jsonl']);
    const lastState = events.findLast((e) => e.kind === 'observer.state');
    expect(lastState?.kind === 'observer.state' && lastState.state.watching).toEqual([
      'CLAUDE_JOURNAL:b.jsonl',
      'CLAUDE_JOURNAL:c.jsonl',
    ]);

    // pollOnce 只服务在槛的两个：改 a 不推，改 c 推
    const dir = claudeDirOf(PROJECT);
    writeFileSync(join(dir, 'a.jsonl'), `${j({ type: 'a2' })}\n`);
    utimesSync(join(dir, 'a.jsonl'), 5_000, 5_000);
    writeFileSync(join(dir, 'c.jsonl'), `${j({ type: 'c2' })}\n`);
    utimesSync(join(dir, 'c.jsonl'), 5_000, 5_000);
    const before = projected().length;
    service.pollOnce();
    expect(projected().slice(before)).toEqual(['CLAUDE_JOURNAL:c.jsonl']);
  });

  it('unwatch 指定一个只关那一个并推状态；不带参数全部停止；对不在槛的 id 静默', () => {
    writeClaudeSession('a.jsonl', [j({ type: 'a' })], 1_000);
    writeClaudeSession('b.jsonl', [j({ type: 'b' })], 2_000);
    service.enable(PROJECT, PROJECT);
    service.watch('CLAUDE_JOURNAL:a.jsonl');
    service.watch('CLAUDE_JOURNAL:b.jsonl');
    events = [];

    service.unwatch('CLAUDE_JOURNAL:ghost.jsonl');
    expect(events).toEqual([]);
    service.unwatch('CLAUDE_JOURNAL:a.jsonl');
    expect(service.status().watching).toEqual(['CLAUDE_JOURNAL:b.jsonl']);
    expect(events).toEqual([
      { kind: 'observer.state', state: { granted: PROJECT, watching: ['CLAUDE_JOURNAL:b.jsonl'] } },
    ]);
    service.unwatch();
    expect(service.status().watching).toEqual([]);
    events = [];
    service.unwatch(); // 已空：不再推
    expect(events).toEqual([]);
  });

  it('会话换届：被删掉的会话从镜像槛移除并推状态', () => {
    const p = writeClaudeSession('gone.jsonl', [j({ type: 'a' })], 1_000);
    writeClaudeSession('stay.jsonl', [j({ type: 'b' })], 2_000);
    service.enable(PROJECT, PROJECT);
    service.watch('CLAUDE_JOURNAL:gone.jsonl');
    service.watch('CLAUDE_JOURNAL:stay.jsonl');
    rmSync(p);
    events = [];
    service.listSessions();
    expect(service.status().watching).toEqual(['CLAUDE_JOURNAL:stay.jsonl']);
    expect(events.some((e) => e.kind === 'observer.state' && e.state.watching.length === 1)).toBe(true);
  });
});

describe('边界与对抗输入', () => {
  it('enable 只收规范化绝对路径：空串 / 相对路径 / 含 .. 的路径一律 BAD_REQUEST（否则空串会扫遍所有项目）', () => {
    for (const bad of ['', 'relative/dir', '/a/../b', '/a/./b']) {
      expect(() => service.enable(bad, bad)).toThrow(/规范化的绝对路径/);
    }
    expect(service.status().granted).toBeNull();
  });

  it('sessionId 里的路径穿越只会撞 UNKNOWN_SESSION —— 会话只能来自 listSessions 的映射', () => {
    writeClaudeSession('ok.jsonl', [j({ type: 'spec' })], 1_000);
    service.enable(PROJECT, PROJECT);
    for (const evil of ['CLAUDE_JOURNAL:../../../etc/passwd', 'CODEX_ROLLOUT:/etc/passwd', 'ok.jsonl']) {
      expect(() => service.watch(evil)).toThrow(/未知会话/);
    }
  });

  it('CRLF 行尾与首行 BOM 都能读；符号链接的会话文件不进列表', () => {
    const dir = claudeDirOf(PROJECT);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'crlf.jsonl'), `\uFEFF${j({ type: 'spec' })}\r\n${j({ type: 'spec' })}\r\n`);
    writeFileSync(join(dir, 'real.jsonl'), `${j({ type: 'spec' })}\n`);
    symlinkSync(join(dir, 'real.jsonl'), join(dir, 'link.jsonl'));
    const { sessions } = service.enable(PROJECT, PROJECT);
    expect(sessions.map((s) => s.label).sort()).toEqual(['crlf', 'real']);

    service.watch('CLAUDE_JOURNAL:crlf.jsonl');
    const ev = events.findLast((e) => e.kind === 'observer.projection');
    const proj = ev?.kind === 'observer.projection' ? ev.projection : null;
    expect(proj?.counts.records).toBe(2);
    expect(proj?.counts.unparseableLines).toBe(0);
  });

  it('被监视的文件消失：pollOnce 静默、不抛、不推；文件被截短：重读并如实报新计数', () => {
    const p = writeClaudeSession('rot.jsonl', [j({ type: 'a' }), j({ type: 'b' }), j({ type: 'c' })], 1_000);
    service.enable(PROJECT, PROJECT);
    service.watch('CLAUDE_JOURNAL:rot.jsonl');
    expect(events.filter((e) => e.kind === 'observer.projection').length).toBe(1);

    writeFileSync(p, `${j({ type: 'a' })}\n`); // 截短（如日志轮转）
    utimesSync(p, 2_000, 2_000);
    service.pollOnce();
    const shrunk = events.findLast((e) => e.kind === 'observer.projection');
    expect(shrunk?.kind === 'observer.projection' && shrunk.projection.counts.records).toBe(1);

    rmSync(p);
    const before = events.length;
    expect(() => service.pollOnce()).not.toThrow();
    expect(events.length).toBe(before);
  });

  it('超过 4MB 的文件只读尾部：报跳过字节数，丢掉第一个残行后无坏行', () => {
    const line = j({ type: 'spec', pad: 'x'.repeat(90) });
    const count = Math.ceil(4_500_000 / (line.length + 1));
    writeClaudeSession('huge.jsonl', Array.from({ length: count }, () => line), 1_000);
    service.enable(PROJECT, PROJECT);
    service.watch('CLAUDE_JOURNAL:huge.jsonl');
    const ev = events.findLast((e) => e.kind === 'observer.projection');
    const proj = ev?.kind === 'observer.projection' ? ev.projection : null;
    expect(proj?.counts.headBytesSkipped).toBeGreaterThan(0);
    expect(proj?.counts.unparseableLines).toBe(0);
    expect(proj?.counts.records).toBeGreaterThan(1000);
    expect(proj?.lines.length).toBe(1); // 全是同类标签行 → 折叠成一行
  });

  it('codex 首行几十 KB（真实 rollout 带整段 base_instructions）必须读得出；超 2MB 上限才判读不出', () => {
    const dir = join(codexRoot, '2026', '09', '05');
    mkdirSync(dir, { recursive: true });
    // 真实首行 19–49KB：16KB 一次性探测曾把 400/400 个文件判成读不出
    writeFileSync(
      join(dir, 'rollout-fat.jsonl'),
      `${j({ type: 'session_meta', payload: { base_instructions: 'x'.repeat(48_000), cwd: PROJECT } })}\n`,
    );
    writeFileSync(
      join(dir, 'rollout-absurd.jsonl'),
      `${j({ type: 'session_meta', payload: { base_instructions: 'x'.repeat(2_100_000), cwd: PROJECT } })}\n`,
    );
    const { sessions, counts } = service.enable(PROJECT, PROJECT);
    expect(sessions.map((s) => s.sessionId)).toEqual(['CODEX_ROLLOUT:2026/09/05/rollout-fat.jsonl']);
    expect(counts.codexMatched).toBe(1);
    expect(counts.codexUnreadable).toBe(1);
  });
});

describe('辅助函数', () => {
  it('mungeClaudeProjectDir：每个非字母数字字符逐一变 -（与真实目录逐字核对过的规则）', () => {
    expect(mungeClaudeProjectDir('/Users/x/Desktop/code-IDE')).toBe('-Users-x-Desktop-code-IDE');
    expect(mungeClaudeProjectDir('/a/.claude-worktrees/b_1')).toBe('-a--claude-worktrees-b-1');
  });

  it('readCodexSessionCwd：首行非 session_meta / 非 JSON / 缺 cwd → null', () => {
    const good = writeCodexRollout('rollout-good.jsonl', '/p');
    expect(readCodexSessionCwd(good)).toBe('/p');
    const broken = writeCodexRollout('rollout-bad.jsonl', null);
    expect(readCodexSessionCwd(broken)).toBeNull();
    const noCwd = join(codexRoot, '2026', '09', '02', 'rollout-nocwd.jsonl');
    writeFileSync(noCwd, `${j({ type: 'session_meta', payload: { id: 'x' } })}\n`);
    expect(readCodexSessionCwd(noCwd)).toBeNull();
  });

  it('projectionLineOf：claude 文本/工具块、codex agent_message、超长截断、控制字符剥离', () => {
    expect(
      projectionLineOf('CLAUDE_JOURNAL', {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', name: 'Read' }] },
      }),
    ).toEqual({ kind: 'assistant', text: 'hi [tool_use]' });
    expect(
      projectionLineOf('CODEX_ROLLOUT', {
        type: 'response_item',
        payload: { type: 'agent_message', content: [{ type: 'output_text', text: 'ok' }] },
      }),
    ).toEqual({ kind: 'assistant', text: 'ok' });
    expect(
      projectionLineOf('CODEX_ROLLOUT', {
        type: 'response_item',
        payload: { type: 'function_call', name: 'shell' },
      }),
    ).toEqual({ kind: '[工具 shell]', text: '' });

    const long = projectionLineOf('CLAUDE_JOURNAL', {
      type: 'user',
      message: { content: 'x'.repeat(700) },
    });
    expect(long.text.endsWith('…（截断）')).toBe(true);
    expect(long.text.length).toBeLessThan(700);

    const dirty = projectionLineOf('CLAUDE_JOURNAL', {
      type: 'user',
      message: { content: 'a\u0007b\u001Bc d-e' },
    });
    expect(dirty.text).toBe('abc d-e');
  });
});
