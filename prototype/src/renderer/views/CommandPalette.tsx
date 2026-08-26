import { useEffect, useMemo, useRef, useState } from 'react';
import { call } from '../bridge';

/**
 * ⌘K 命令面板（交互评审 v0.1 #10 / v0.2 P2）。
 *
 * IDE 用户遇到"找不到入口"的第一反射是 ⌘K —— 这里给它一个着陆点：
 * 动作 / 切换运行 / 打开项目 / 打开文件，全部走已有 IPC，不新增任何权威。
 *
 * 两条纪律：
 *   - 文件列表按需拉取（面板打开时一次 files.tree），失败如实展示，不静默变空；
 *   - 结果超出上限时报数（"还有 N 项"）—— 折叠 + 报数 = 合规省略，搜索框也一样。
 */

export interface PaletteCommand {
  readonly id: string;
  readonly group: '动作' | '运行' | '项目';
  readonly label: string;
  readonly detail?: string;
  readonly run: () => void;
}

interface Row {
  readonly id: string;
  readonly group: string;
  readonly label: string;
  readonly detail?: string;
  readonly run: () => void;
}

const MAX_ROWS = 24;

export function CommandPalette({
  open,
  onClose,
  commands,
  fileSource,
  onOpenFile,
}: {
  open: boolean;
  onClose: () => void;
  commands: readonly PaletteCommand[];
  /** 可浏览文件时的树来源；null = 不提供文件项（未导入项目 / 证据损坏） */
  fileSource: { snapshotId: string; runId: string | null } | null;
  onOpenFile: (path: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const [files, setFiles] = useState<readonly string[] | null>(null);
  const [filesError, setFilesError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  // 打开时：记住焦点来处、清空输入、按需拉一次文件树
  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setQuery('');
    setIndex(0);
    setFiles(null);
    setFilesError(null);
    inputRef.current?.focus();
    if (!fileSource) return;
    let live = true;
    call('files.tree', {
      snapshotId: fileSource.snapshotId,
      ...(fileSource.runId ? { runId: fileSource.runId } : {}),
    })
      .then((r) => {
        if (live) setFiles(r.entries.map((e) => e.path));
      })
      .catch((err) => {
        if (live) setFilesError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      live = false;
    };
  }, [open, fileSource]);

  const close = () => {
    onClose();
    restoreFocusRef.current?.focus?.();
  };

  const { rows, hiddenCount } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const hit = (text: string | undefined) => text !== undefined && text.toLowerCase().includes(q);
    const all: Row[] = [
      ...commands.filter((c) => q === '' || hit(c.label) || hit(c.detail)),
      ...(files ?? [])
        .filter((p) => q === '' || p.toLowerCase().includes(q))
        .map((p) => ({
          id: `file:${p}`,
          group: '文件',
          label: p.slice(p.lastIndexOf('/') + 1),
          detail: p,
          run: () => onOpenFile(p),
        })),
    ];
    return { rows: all.slice(0, MAX_ROWS), hiddenCount: Math.max(0, all.length - MAX_ROWS) };
  }, [query, commands, files, onOpenFile]);

  useEffect(() => {
    setIndex((i) => Math.min(i, Math.max(0, rows.length - 1)));
  }, [rows.length]);

  if (!open) return null;

  return (
    // 点背景关闭；Esc 在输入框上处理 —— 焦点始终在输入框里，不需要全局监听
    <div className="palette-overlay" onMouseDown={close}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="命令面板"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="palette-input"
          value={query}
          placeholder="输入以过滤：动作 / 运行 / 项目 / 文件"
          aria-label="命令面板输入"
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              close();
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setIndex((i) => Math.min(i + 1, rows.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setIndex((i) => Math.max(i - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              const row = rows[index];
              if (row) {
                close();
                row.run();
              }
            }
          }}
        />
        <div className="palette-list" role="listbox" aria-label="命令列表">
          {rows.map((row, i) => (
            <button
              key={row.id}
              role="option"
              aria-selected={i === index}
              className={`palette-row ${i === index ? 'active' : ''}`}
              // mousedown 抢在 blur 之前执行，click 会因焦点变化被吞
              onMouseDown={(e) => {
                e.preventDefault();
                close();
                row.run();
              }}
              onMouseEnter={() => setIndex(i)}
            >
              <span className="palette-group">{row.group}</span>
              <span className="palette-label">{row.label}</span>
              {row.detail && <span className="palette-detail">{row.detail}</span>}
            </button>
          ))}
          {rows.length === 0 && <div className="palette-empty">没有匹配"{query.trim()}"的项</div>}
          {hiddenCount > 0 && (
            <div className="palette-more">还有 {hiddenCount} 项 —— 继续输入以缩小范围</div>
          )}
          {fileSource && files === null && filesError === null && (
            <div className="palette-more" role="status">
              正在读取文件列表…
            </div>
          )}
          {filesError && <div className="palette-more">文件列表读取失败：{filesError}</div>}
        </div>
      </div>
    </div>
  );
}
