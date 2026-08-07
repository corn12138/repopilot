import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FileTreeEntry } from '@shared/domain';
import { call } from '../bridge';
import { Badge } from '../components/common';

interface TreeNode {
  name: string;
  path: string;
  children: Map<string, TreeNode>;
  entry: FileTreeEntry | null;
}

function buildTree(entries: readonly FileTreeEntry[]): TreeNode {
  const root: TreeNode = { name: '', path: '', children: new Map(), entry: null };
  for (const entry of entries) {
    let node = root;
    const parts = entry.path.split('/');
    parts.forEach((part, i) => {
      const path = parts.slice(0, i + 1).join('/');
      let child = node.children.get(part);
      if (!child) {
        child = { name: part, path, children: new Map(), entry: null };
        node.children.set(part, child);
      }
      if (i === parts.length - 1) child.entry = entry;
      node = child;
    });
  }
  return root;
}

/** 目录里有改动过的文件时，目录本身也标记出来，便于一眼定位 Agent 动了哪 */
function hasChanged(node: TreeNode): boolean {
  if (node.entry) return node.entry.changed;
  for (const child of node.children.values()) if (hasChanged(child)) return true;
  return false;
}

function sortedChildren(node: TreeNode): TreeNode[] {
  return [...node.children.values()].sort((a, b) => {
    const aDir = a.children.size > 0;
    const bDir = b.children.size > 0;
    if (aDir !== bDir) return aDir ? -1 : 1;
    return a.name < b.name ? -1 : 1;
  });
}

export function FileTreePanel({
  snapshotId,
  runId,
  refreshKey,
  onClose,
}: {
  snapshotId: string;
  runId: string | null;
  /** 变化时重新拉取；用于 Agent 改完文件后刷新 */
  refreshKey: number;
  onClose: () => void;
}) {
  const [entries, setEntries] = useState<FileTreeEntry[]>([]);
  const [meta, setMeta] = useState<{ source: string; generation: number | null } | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [file, setFile] = useState<{
    path: string;
    content: string;
    bytes: number;
    truncated: boolean;
    binary: boolean;
    changed: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await call('files.tree', { snapshotId, ...(runId ? { runId } : {}) });
      setEntries(r.entries);
      setMeta({ source: r.source, generation: r.generation });
      setError(null);
      // 首次自动展开顶层目录，省一次点击
      setExpanded((prev) => {
        if (prev.size > 0) return prev;
        const top = new Set<string>();
        for (const e of r.entries) {
          const first = e.path.split('/')[0]!;
          if (e.path.includes('/')) top.add(first);
        }
        return top;
      });
    } catch (err) {
      setError((err as Error).message);
    }
  }, [snapshotId, runId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const openFile = async (path: string) => {
    setSelected(path);
    try {
      setFile(await call('files.read', { snapshotId, path, ...(runId ? { runId } : {}) }));
    } catch (err) {
      setError((err as Error).message);
      setFile(null);
    }
  };

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((e) => e.path.toLowerCase().includes(q));
  }, [entries, filter]);

  const tree = useMemo(() => buildTree(filtered), [filtered]);
  const changedCount = entries.filter((e) => e.changed).length;
  // 搜索时把所有目录都展开，否则结果被折叠着看不见
  const forceExpand = filter.trim().length > 0;

  const renderNode = (node: TreeNode, depth: number): React.ReactNode => {
    const isDir = node.children.size > 0;
    const isOpen = forceExpand || expanded.has(node.path);
    const changed = hasChanged(node);

    return (
      <div key={node.path}>
        <button
          className={`tree-row ${selected === node.path ? 'active' : ''}`}
          style={{ paddingLeft: 6 + depth * 12 }}
          onClick={() => {
            if (isDir) {
              setExpanded((prev) => {
                const next = new Set(prev);
                if (next.has(node.path)) next.delete(node.path);
                else next.add(node.path);
                return next;
              });
            } else {
              void openFile(node.path);
            }
          }}
        >
          <span className="tree-caret">{isDir ? (isOpen ? '▾' : '▸') : ''}</span>
          <span className={`tree-name ${changed ? 'changed' : ''}`}>{node.name}</span>
          {changed && !isDir && <span className="tree-dot" />}
        </button>
        {isDir && isOpen && sortedChildren(node).map((c) => renderNode(c, depth + 1))}
      </div>
    );
  };

  return (
    <aside className="filepanel">
      <div className="filepanel-head">
        <strong style={{ fontSize: 12 }}>文件</strong>
        <span className="spacer" />
        {meta && (
          <Badge tone={meta.source === 'WORKSPACE' ? 'info' : 'default'}>
            {meta.source === 'WORKSPACE' ? `工作区 gen-${meta.generation}` : '快照'}
          </Badge>
        )}
        {changedCount > 0 && <Badge tone="ok">{changedCount} 改动</Badge>}
        <button onClick={() => void load()} title="刷新">
          ↻
        </button>
        <button onClick={onClose} title="关闭">
          ✕
        </button>
      </div>

      <input
        className="filepanel-filter"
        value={filter}
        placeholder="过滤路径…"
        onChange={(e) => setFilter(e.target.value)}
      />

      {error && <div className="filepanel-error">{error}</div>}

      <div className="filepanel-tree">
        {entries.length === 0 && !error ? (
          <div className="empty" style={{ padding: 20 }}>
            没有文件
          </div>
        ) : (
          sortedChildren(tree).map((n) => renderNode(n, 0))
        )}
      </div>

      {file && (
        <div className="filepanel-viewer">
          <div className="filepanel-viewer-head">
            <code style={{ fontSize: 11 }}>{file.path}</code>
            <span className="spacer" />
            {file.changed && <Badge tone="ok">已改动</Badge>}
            <span style={{ color: 'var(--text-faint)', fontSize: 10.5 }}>{file.bytes} B</span>
            <button onClick={() => setFile(null)} title="收起">
              ✕
            </button>
          </div>
          <pre className="filepanel-code">
            {file.binary ? '（二进制文件，不显示内容）' : file.content}
            {file.truncated && '\n\n… 内容过长已截断'}
          </pre>
        </div>
      )}
    </aside>
  );
}
