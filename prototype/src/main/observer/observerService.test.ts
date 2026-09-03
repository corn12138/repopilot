import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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
    expect(service.status()).toEqual({ granted: null, watching: null });
  });

  it('enable 后按项目发现两家会话：claude 走 munge 目录、codex 按首行 cwd 过滤；条目不带宿主路径', () => {
    writeClaudeSession('aaa.jsonl', [j({ type: 'spec-line' })], 1_000);
    writeClaudeSession('bbb.jsonl', [j({ type: 'spec-line' })], 2_000);
    writeCodexRollout('rollout-match.jsonl', PROJECT);
    writeCodexRollout('rollout-other.jsonl', '/somewhere/else');
    writeCodexRollout('rollout-broken.jsonl', null);

    const { sessions, counts } = service.enable(PROJECT, '~/demo-project');
    expect(sessions.map((s) => s.sessionId).sort()).toEqual([
      'CLAUDE_JOURNAL:aaa.jsonl',
      'CLAUDE_JOURNAL:bbb.jsonl',
      'CODEX_ROLLOUT:rollout-match.jsonl',
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

  it('违反基线必现键 → FORMAT_UNKNOWN：正文清空、违规键名可见、计数保留', () => {
    // 已提交基线认识 claude 的 user 且必现键不止 type —— 光杆 user 必然违规
    writeClaudeSession('bad.jsonl', [j({ type: 'user' })], 1_000);
    service.enable(PROJECT, PROJECT);
    service.watch('CLAUDE_JOURNAL:bad.jsonl');
    const ev = events.find((e) => e.kind === 'observer.projection');
    const proj = ev?.kind === 'observer.projection' ? ev.projection : null;
    expect(proj?.status).toBe('FORMAT_UNKNOWN');
    expect(proj?.breaking.length).toBeGreaterThan(0);
    expect(proj?.breaking.every((b) => b.startsWith('top:user.'))).toBe(true);
    expect(proj?.lines).toEqual([]);
    expect(proj?.counts.records).toBe(1);
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
    expect(service.status()).toEqual({ granted: null, watching: null });
    expect(events).toEqual([{ kind: 'observer.state', state: { granted: null, watching: null } }]);

    events = [];
    service.pollOnce();
    expect(events).toEqual([]);
    expect(() => service.listSessions()).toThrow(ObserverError);
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
