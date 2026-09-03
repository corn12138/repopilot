import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_KEYS_PER_RECORD,
  MAX_LINES_PER_FILE,
  captureShape,
  diffShape,
  discoverJournalFiles,
  parseSnapshot,
  recordShapeViolations,
  serializeSnapshot,
  type JournalShapeSnapshot,
} from './journalShape';

const j = (o: unknown): string => JSON.stringify(o);

function snap(partial: Partial<JournalShapeSnapshot>): JournalShapeSnapshot {
  return {
    vendor: 'CLAUDE_JOURNAL',
    capturedAt: '2026-09-02T00:00:00.000Z',
    files: 1,
    records: 1,
    unparseableLines: 0,
    blankLines: 0,
    truncatedLines: 0,
    droppedForTypeCap: 0,
    types: {},
    payloadTypes: null,
    ...partial,
  };
}

describe('captureShape：两层字段模型', () => {
  it('required=每条都有，optional=部分记录有；键与 type 均排序', () => {
    const s = captureShape('CLAUDE_JOURNAL', [
      [j({ type: 'user', uuid: 'x', cwd: '/a' }), j({ type: 'user', uuid: 'y' }), j({ type: 'system', note: 1 })],
    ]);
    expect(Object.keys(s.types)).toEqual(['system', 'user']);
    expect(s.types['user']).toEqual({ required: ['type', 'uuid'], optional: ['cwd'] });
    expect(s.types['system']).toEqual({ required: ['note', 'type'], optional: [] });
    expect(s.records).toBe(3);
  });

  it('缺 type / type 非字符串 → 归入 UNTYPED，不抛', () => {
    const s = captureShape('CLAUDE_JOURNAL', [[j({ a: 1 }), j({ type: 42, a: 1 })]]);
    expect(s.types['UNTYPED']?.optional).toContain('type');
    expect(s.records).toBe(2);
  });

  it('坏 JSON、数组行、超键数记录 → unparseable 计数，不抛不参与形状', () => {
    const fat: Record<string, number> = {};
    for (let i = 0; i < MAX_KEYS_PER_RECORD + 1; i += 1) fat[`k${i}`] = i;
    const s = captureShape('CLAUDE_JOURNAL', [['{oops', j([1, 2]), j('str'), j(fat), j({ type: 'ok' })]]);
    expect(s.unparseableLines).toBe(4);
    expect(s.records).toBe(1);
    expect(Object.keys(s.types)).toEqual(['ok']);
  });

  it('空行单独计数，不算 unparseable', () => {
    const s = captureShape('CLAUDE_JOURNAL', [['', '   ', j({ type: 'a' })]]);
    expect(s.blankLines).toBe(2);
    expect(s.unparseableLines).toBe(0);
  });

  it('超出单文件行数上限 → 截断且报数（省略要报数）', () => {
    const lines = Array.from({ length: MAX_LINES_PER_FILE + 7 }, () => j({ type: 'a' }));
    const s = captureShape('CLAUDE_JOURNAL', [lines]);
    expect(s.truncatedLines).toBe(7);
    expect(s.records).toBe(MAX_LINES_PER_FILE);
  });

  it('CODEX：payload 两级形状；payload 非对象则只记顶层', () => {
    const s = captureShape('CODEX_ROLLOUT', [
      [
        j({ type: 'event_msg', payload: { type: 'token_count', total: 1 } }),
        j({ type: 'event_msg', payload: { type: 'token_count', total: 2, model: 'x' } }),
        j({ type: 'event_msg', payload: 'not-an-object' }),
      ],
    ]);
    expect(s.payloadTypes?.['token_count']).toEqual({ required: ['total', 'type'], optional: ['model'] });
    expect(s.types['event_msg']?.required).toEqual(['payload', 'type']);
  });

  it('CLAUDE 快照 payloadTypes 恒为 null（不假装有第二层）', () => {
    const s = captureShape('CLAUDE_JOURNAL', [[j({ type: 'a', payload: { type: 'x' } })]]);
    expect(s.payloadTypes).toBeNull();
  });
});

describe('diffShape：漂移判定', () => {
  const baseline = snap({
    types: {
      user: { required: ['type', 'uuid'], optional: ['cwd'] },
      system: { required: ['note', 'type'], optional: [] },
    },
  });

  it('基线必现键完全缺席 → BREAKING（MISSING）', () => {
    const cur = snap({ types: { user: { required: ['type'], optional: [] } } });
    const r = diffShape(baseline, cur);
    expect(r.verdict).toBe('BREAKING_DRIFT');
    expect(r.breaking.some((x) => x.includes('MISSING') && x.includes('user.uuid'))).toBe(true);
  });

  it('基线必现键降级为部分记录含 → BREAKING（DEMOTED）', () => {
    const cur = snap({ types: { user: { required: ['type'], optional: ['uuid'] } } });
    const r = diffShape(baseline, cur);
    expect(r.verdict).toBe('BREAKING_DRIFT');
    expect(r.breaking.some((x) => x.includes('DEMOTED') && x.includes('user.uuid'))).toBe(true);
  });

  it('新 type / 新键 → ADDITIVE，不判红', () => {
    const cur = snap({
      types: {
        user: { required: ['type', 'uuid'], optional: ['cwd', 'brandNew'] },
        attachment: { required: ['type'], optional: [] },
      },
    });
    const r = diffShape(baseline, cur);
    expect(r.verdict).toBe('ADDITIVE_DRIFT');
    expect(r.breaking).toEqual([]);
    expect(r.additive.some((x) => x.includes('新 type：attachment'))).toBe(true);
    expect(r.additive.some((x) => x.includes('user.brandNew'))).toBe(true);
  });

  it('基线 type 本次未观测 → 不定罪，只进 unobserved 报数（样本没出现 ≠ 格式删掉了）', () => {
    const cur = snap({ types: { user: { required: ['type', 'uuid'], optional: [] } } });
    const r = diffShape(baseline, cur);
    expect(r.verdict).toBe('MATCH');
    expect(r.unobservedTypes).toEqual(['top:system']);
  });

  it('optional 键缺席不构成任何漂移（它本来就不必现）', () => {
    const cur = snap({
      types: { user: { required: ['type', 'uuid'], optional: [] }, system: { required: ['note', 'type'], optional: [] } },
    });
    expect(diffShape(baseline, cur).verdict).toBe('MATCH');
  });

  it('payload 层与顶层同规则；基线有 payload 而本次全无 → 全部进 unobservedPayloadTypes', () => {
    const base = snap({
      vendor: 'CODEX_ROLLOUT',
      types: { event_msg: { required: ['payload', 'type'], optional: [] } },
      payloadTypes: { token_count: { required: ['total', 'type'], optional: [] } },
    });
    const cur = snap({
      vendor: 'CODEX_ROLLOUT',
      types: { event_msg: { required: ['payload', 'type'], optional: [] } },
      payloadTypes: {},
    });
    const r = diffShape(base, cur);
    expect(r.verdict).toBe('MATCH');
    expect(r.unobservedPayloadTypes).toEqual(['payload:token_count']);
  });

  it('不同 vendor 的快照对照是编程错误 → 抛', () => {
    expect(() => diffShape(baseline, snap({ vendor: 'CODEX_ROLLOUT', payloadTypes: {} }))).toThrow(/vendor/);
  });
});

describe('parseSnapshot：仓库基线的自检（烂基线必须当场抛）', () => {
  it('serialize → parse 往返成立', () => {
    const s = captureShape('CODEX_ROLLOUT', [[j({ type: 'a', payload: { type: 'p', v: 1 } })]]);
    const back = parseSnapshot(serializeSnapshot(s));
    expect(back.types).toEqual(s.types);
    expect(back.payloadTypes).toEqual(s.payloadTypes);
  });

  it('vendor 不合法 / 键列表乱序 / required∩optional 重叠 / CODEX 缺 payloadTypes → 全部抛', () => {
    expect(() => parseSnapshot(j({ vendor: 'NOPE', types: {} }))).toThrow(/vendor/);
    expect(() =>
      parseSnapshot(j({ vendor: 'CLAUDE_JOURNAL', types: { a: { required: ['b', 'a'], optional: [] } } })),
    ).toThrow(/升序/);
    expect(() =>
      parseSnapshot(j({ vendor: 'CLAUDE_JOURNAL', types: { a: { required: ['k'], optional: ['k'] } } })),
    ).toThrow(/重叠/);
    expect(() => parseSnapshot(j({ vendor: 'CODEX_ROLLOUT', types: {}, payloadTypes: null }))).toThrow(/payloadTypes/);
  });
});

describe('discoverJournalFiles：有界扫描', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  it('递归收 .jsonl、按 mtime 取最新 maxFiles 个、跳过数报数、忽略非 jsonl 与 symlink、坏目录不抛', () => {
    dir = mkdtempSync(join(tmpdir(), 'repopilot-journal-test-'));
    mkdirSync(join(dir, 'sub'));
    const mk = (rel: string, mtimeSec: number): void => {
      const p = join(dir, rel);
      writeFileSync(p, '{}\n');
      utimesSync(p, mtimeSec, mtimeSec);
    };
    mk('old.jsonl', 1_000);
    mk(join('sub', 'new.jsonl'), 2_000);
    mk(join('sub', 'newest.jsonl'), 3_000);
    writeFileSync(join(dir, 'note.txt'), 'x');
    symlinkSync(join(dir, 'old.jsonl'), join(dir, 'link.jsonl'));

    const sweep = discoverJournalFiles(dir, { maxFiles: 2 });
    expect(sweep.files.map((f) => f.split('/').pop())).toEqual(['newest.jsonl', 'new.jsonl']);
    expect(sweep.totalMatched).toBe(3);
    expect(sweep.skippedFiles).toBe(1);
    expect(sweep.symlinksSkipped).toBe(1);

    const missing = discoverJournalFiles(join(dir, 'no-such-dir'), { maxFiles: 5 });
    expect(missing.files).toEqual([]);
    expect(missing.unreadableDirs).toBe(1);
  });

  it('fileNameFilter 生效（codex 只认 rollout-*）', () => {
    dir = mkdtempSync(join(tmpdir(), 'repopilot-journal-test-'));
    writeFileSync(join(dir, 'rollout-a.jsonl'), '{}\n');
    writeFileSync(join(dir, 'other.jsonl'), '{}\n');
    const sweep = discoverJournalFiles(dir, { maxFiles: 10, fileNameFilter: (n) => n.startsWith('rollout-') });
    expect(sweep.files.map((f) => f.split('/').pop())).toEqual(['rollout-a.jsonl']);
    expect(sweep.totalMatched).toBe(1);
  });
});

describe('已提交的字段快照基线', () => {
  const here = (name: string): string => fileURLToPath(new URL(name, import.meta.url));
  const committed = [
    { file: here('claude-journal.shape.json'), vendor: 'CLAUDE_JOURNAL' },
    { file: here('codex-rollout.shape.json'), vendor: 'CODEX_ROLLOUT' },
  ] as const;

  it('两份基线存在、能过 parseSnapshot 自检、vendor 正确、非空', () => {
    for (const { file, vendor } of committed) {
      expect(existsSync(file), `缺基线 ${file} —— 用 REPOPILOT_PROBE_JOURNALS=update pnpm probe:journals 生成`).toBe(true);
      const s = parseSnapshot(readFileSync(file, 'utf8'));
      expect(s.vendor).toBe(vendor);
      expect(Object.keys(s.types).length).toBeGreaterThan(0);
      expect(s.records).toBeGreaterThan(0);
    }
  });
});

describe('recordShapeViolations：单条记录守卫（观察面板逐条用）', () => {
  const baseline = snap({
    vendor: 'CODEX_ROLLOUT',
    types: { user: { required: ['type', 'uuid'], optional: ['cwd'] } },
    payloadTypes: { token_count: { required: ['total', 'type'], optional: [] } },
  });

  it('已知 type 缺必现键 → 逐键报违规', () => {
    expect(recordShapeViolations(baseline, { type: 'user' })).toEqual(['top:user.uuid']);
  });

  it('optional 键缺席不算违规；未知 type 不算违规（增量漂移不定罪）', () => {
    expect(recordShapeViolations(baseline, { type: 'user', uuid: 'x' })).toEqual([]);
    expect(recordShapeViolations(baseline, { type: 'brand-new', whatever: 1 })).toEqual([]);
  });

  it('payload 层同规则；基线无 payloadTypes 时 payload 不参与判定', () => {
    expect(
      recordShapeViolations(baseline, { type: 'user', uuid: 'x', payload: { type: 'token_count' } }),
    ).toEqual(['payload:token_count.total']);
    const noPayloadBaseline = snap({ types: { user: { required: ['type'], optional: [] } } });
    expect(
      recordShapeViolations(noPayloadBaseline, { type: 'user', payload: { type: 'token_count' } }),
    ).toEqual([]);
  });
});
