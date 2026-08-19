import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FileTreeEntry } from '@shared/domain';
import { call } from '../bridge';
import { Badge } from '../components/common';
import {
  createLatestRequestGuard,
  OWNED_ASYNC_IDLE,
  type LatestRequestGuard,
  type OwnedAsyncState,
} from '../ownedAsync';

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

interface TreeRequestOwner {
  readonly snapshotId: string;
  readonly runId: string | null;
  /** 请求发出时 Renderer 已知的 generation；它是 hint，不冒充 Core 的响应事实。 */
  readonly workspaceGeneration: number | null;
}

interface TreeResult {
  readonly entries: readonly FileTreeEntry[];
  readonly source: 'SNAPSHOT' | 'WORKSPACE';
  /** Core 针对此次 tree 请求实际读取的 generation。 */
  readonly workspaceGeneration: number | null;
}

interface FileRequestOwner extends TreeRequestOwner {
  readonly path: string;
}

interface FileResult {
  readonly path: string;
  readonly content: string;
  readonly bytes: number;
  readonly truncated: boolean;
  readonly binary: boolean;
  readonly changed: boolean;
  readonly source: 'SNAPSHOT' | 'WORKSPACE';
  readonly generation: number | null;
}

type TreeLoadState = OwnedAsyncState<TreeRequestOwner, TreeResult, string>;
type FileLoadState = OwnedAsyncState<FileRequestOwner, FileResult, string>;

function sameTreeOwner(a: TreeRequestOwner, b: TreeRequestOwner): boolean {
  return (
    a.snapshotId === b.snapshotId &&
    a.runId === b.runId &&
    a.workspaceGeneration === b.workspaceGeneration
  );
}

function sameFileOwner(a: FileRequestOwner, b: FileRequestOwner): boolean {
  return sameTreeOwner(a, b) && a.path === b.path;
}

/**
 * 同一个浏览实体，可能是不同代。
 *
 * generation 是这个实体的版本，不是另一个实体。区分二者，才能既不把 A 的内容画到 B 上，
 * 又不在 Agent 每写一个文件时把整棵树、展开状态和正在读的文件全部清空重来。
 */
function sameTreeEntity(a: TreeRequestOwner, b: TreeRequestOwner): boolean {
  return a.snapshotId === b.snapshotId && a.runId === b.runId;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function treeOwnershipError(
  runId: string | null,
  result: { source: 'SNAPSHOT' | 'WORKSPACE'; generation: number | null },
): string | null {
  if (runId) {
    if (
      result.source !== 'WORKSPACE' ||
      typeof result.generation !== 'number' ||
      !Number.isSafeInteger(result.generation) ||
      result.generation < 0
    ) {
      return (
        `文件树响应归属不匹配：Run ${runId} 必须返回 WORKSPACE/非负整数 generation，` +
        `实际 ${result.source}/gen-${String(result.generation)}`
      );
    }
    return null;
  }
  if (result.source !== 'SNAPSHOT' || result.generation !== null) {
    return (
      '文件树响应归属不匹配：快照浏览必须返回 SNAPSHOT/null generation，' +
      `实际 ${result.source}/gen-${String(result.generation)}`
    );
  }
  return null;
}

export function FileTreePanel({
  snapshotId,
  runId,
  workspaceGeneration = null,
  refreshKey,
  onClose,
}: {
  snapshotId: string;
  runId: string | null;
  /** 当前 Run 投影中的 generation；仅作为请求 owner hint，最终以 tree 响应为准。 */
  workspaceGeneration?: number | null;
  /** 变化时重新拉取；用于 Agent 改完文件后刷新 */
  refreshKey: number;
  onClose: () => void;
}) {
  const treeRequestsRef = useRef<LatestRequestGuard<TreeRequestOwner> | null>(null);
  const fileRequestsRef = useRef<LatestRequestGuard<FileRequestOwner> | null>(null);
  if (treeRequestsRef.current === null) {
    treeRequestsRef.current = createLatestRequestGuard<TreeRequestOwner>();
  }
  if (fileRequestsRef.current === null) {
    fileRequestsRef.current = createLatestRequestGuard<FileRequestOwner>();
  }
  const treeRequests = treeRequestsRef.current;
  const fileRequests = fileRequestsRef.current;

  const [treeState, setTreeState] = useState<TreeLoadState>(OWNED_ASYNC_IDLE);
  const [fileState, setFileState] = useState<FileLoadState>(OWNED_ASYNC_IDLE);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  /** 正在读的文件路径，供刷新后自动重读用；state 会随渲染滞后，ref 不会。 */
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selected;

  const openFile = useCallback(
    async (path: string, tree: TreeResult) => {
      const owner: FileRequestOwner = {
        snapshotId,
        runId,
        // 文件归属使用 Core 确认的 tree generation，不能拿请求时的 hint 代替事实。
        workspaceGeneration: tree.workspaceGeneration,
        path,
      };
      const identity = fileRequests.begin(owner);
      setSelected(path);
      setFileState({ status: 'loading', ...identity });
      try {
        const result = await call('files.read', {
          snapshotId,
          path,
          expectedGeneration: tree.workspaceGeneration,
          ...(runId ? { runId } : {}),
        });
        // 文件请求可能在切换路径/来源后才完成；只有完整 owner 仍最新时才能渲染。
        if (!fileRequests.isLatest(identity)) return;
        if (
          result.path !== path ||
          result.source !== tree.source ||
          result.generation !== tree.workspaceGeneration
        ) {
          setFileState({
            status: 'error',
            ...identity,
            error:
              `文件响应归属不匹配：请求 ${tree.source}/gen-${String(tree.workspaceGeneration)}/${path}，` +
              `返回 ${result.source}/gen-${String(result.generation)}/${result.path}`,
          });
          return;
        }
        setFileState({ status: 'ready', ...identity, data: result });
      } catch (err) {
        if (!fileRequests.isLatest(identity)) return;
        setFileState({ status: 'error', ...identity, error: errorMessage(err) });
      }
    },
    [fileRequests, runId, snapshotId],
  );

  const load = useCallback(async () => {
    const owner: TreeRequestOwner = { snapshotId, runId, workspaceGeneration };
    const previousOwner = treeRequests.latest()?.ownerId ?? null;
    const entityChanged = previousOwner === null || !sameTreeEntity(previousOwner, owner);
    const identity = treeRequests.begin(owner);

    // Tree generation 是 file preview 的归属根；tree 一刷新，旧 file 请求即失去写 UI 的资格。
    fileRequests.invalidate();
    /*
     * 换实体才清空用户的位置。同一个 Run 写了个文件就把展开状态、选中文件和整棵树
     * 全部清掉，是原型此前"生硬"的主要来源之一：Agent 每改一次文件，用户正在读的
     * 东西就消失一次。旧内容在这里保留下来，但下面会显式标成"上一代、只读"。
     */
    const keepPath = entityChanged ? null : selectedRef.current;
    if (entityChanged) {
      setFileState(OWNED_ASYNC_IDLE);
      setSelected(null);
      setExpanded(new Set());
      setTreeState({ status: 'loading', ...identity });
    }

    try {
      const r = await call('files.tree', { snapshotId, ...(runId ? { runId } : {}) });
      // Promise 无法证明自己仍属于当前面板；owner + requestId 才是提交状态的门禁。
      if (!treeRequests.isLatest(identity)) return;
      const ownershipError = treeOwnershipError(runId, r);
      if (ownershipError) {
        setTreeState({ status: 'error', ...identity, error: ownershipError });
        return;
      }
      const data: TreeResult = {
        entries: r.entries,
        source: r.source,
        workspaceGeneration: r.generation,
      };
      setTreeState({ status: 'ready', ...identity, data });
      // 首次或换实体时自动展开顶层目录，省一次点击；同实体刷新保留用户的折叠选择。
      setExpanded((prev) => {
        if (!entityChanged && prev.size > 0) return prev;
        const top = new Set<string>();
        for (const e of r.entries) {
          const first = e.path.split('/')[0]!;
          if (e.path.includes('/')) top.add(first);
        }
        return top;
      });
      // 新一代里这个文件还在，就把它按新 generation 重读；不在了就明确收起。
      if (keepPath !== null) {
        if (r.entries.some((e) => e.path === keepPath)) {
          void openFile(keepPath, data);
        } else {
          setFileState(OWNED_ASYNC_IDLE);
          setSelected(null);
        }
      }
    } catch (err) {
      if (!treeRequests.isLatest(identity)) return;
      setTreeState({ status: 'error', ...identity, error: errorMessage(err) });
    }
  }, [fileRequests, openFile, runId, snapshotId, treeRequests, workspaceGeneration]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  useEffect(
    () => () => {
      treeRequests.invalidate();
      fileRequests.invalidate();
    },
    [fileRequests, treeRequests],
  );

  const currentTreeOwner: TreeRequestOwner = { snapshotId, runId, workspaceGeneration };
  /*
   * 两层归属：实体层决定"这份内容还值不值得留在屏幕上"，代层决定"它还能不能被操作"。
   * 只有代层匹配的树是权威树；实体相同但代落后的树可以继续显示，但必须标明是上一代
   * 且不可点击 —— 否则用户会对着旧坐标系点开文件，然后收到一个 Core 的 CONFLICT。
   */
  const entityTreeState =
    treeState.status !== 'idle' && sameTreeEntity(treeState.ownerId, currentTreeOwner)
      ? treeState
      : null;
  const ownedTreeState =
    entityTreeState !== null && sameTreeOwner(entityTreeState.ownerId, currentTreeOwner)
      ? entityTreeState
      : null;
  const treeResult = ownedTreeState?.status === 'ready' ? ownedTreeState.data : null;
  const staleTreeResult =
    treeResult === null && entityTreeState?.status === 'ready' ? entityTreeState.data : null;
  /** 屏幕上正在显示的那棵树 —— 可能是权威的，也可能是被标记为上一代的。 */
  const shownTree = treeResult ?? staleTreeResult;

  const closeFile = () => {
    fileRequests.invalidate();
    setFileState(OWNED_ASYNC_IDLE);
    setSelected(null);
  };

  /*
   * 预览的归属跟着屏幕上那棵树走。刷新期间用 shownTree，正在读的文件才不会闪掉；
   * 它连同树一起被标成上一代，所以"还在显示"不等于"这就是最新内容"。
   */
  const expectedFileOwner: FileRequestOwner | null =
    selected && shownTree
      ? {
          snapshotId,
          runId,
          workspaceGeneration: shownTree.workspaceGeneration,
          path: selected,
        }
      : null;
  const ownedFileState =
    fileState.status !== 'idle' &&
    expectedFileOwner !== null &&
    sameFileOwner(fileState.ownerId, expectedFileOwner)
      ? fileState
      : null;
  const file = ownedFileState?.status === 'ready' ? ownedFileState.data : null;

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!shownTree) return [];
    if (!q) return shownTree.entries;
    return shownTree.entries.filter((e) => e.path.toLowerCase().includes(q));
  }, [filter, shownTree]);

  const tree = useMemo(() => buildTree(filtered), [filtered]);
  const changedCount = shownTree?.entries.filter((e) => e.changed).length ?? 0;
  // 搜索时把所有目录都展开，否则结果被折叠着看不见
  const forceExpand = filter.trim().length > 0;
  const treeError = ownedTreeState?.status === 'error' ? ownedTreeState.error : null;
  // 有上一代内容可显示时不算 loading：那会把屏幕清空，正是要避免的动作。
  const treeLoading =
    staleTreeResult === null && (ownedTreeState === null || ownedTreeState.status === 'loading');
  const fileLoading = ownedFileState?.status === 'loading';
  const fileError = ownedFileState?.status === 'error' ? ownedFileState.error : null;

  const renderNode = (node: TreeNode, depth: number): React.ReactNode => {
    const isDir = node.children.size > 0;
    const isOpen = forceExpand || expanded.has(node.path);
    const changed = hasChanged(node);

    return (
      <div key={node.path}>
        <button
          className={`tree-row ${selected === node.path ? 'active' : ''}`}
          style={{ paddingLeft: 6 + depth * 12 }}
          // 上一代的树只用于保持画面稳定；对它点击等于对着过期坐标系操作。
          disabled={treeResult === null}
          onClick={() => {
            if (isDir) {
              setExpanded((prev) => {
                const next = new Set(prev);
                if (next.has(node.path)) next.delete(node.path);
                else next.add(node.path);
                return next;
              });
            } else {
              if (treeResult) void openFile(node.path, treeResult);
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
    <aside
      className="filepanel rp-enter"
      aria-label="文件浏览器"
      aria-busy={treeLoading || fileLoading}
    >
      <div className="filepanel-head">
        <strong style={{ fontSize: 12 }}>文件</strong>
        <span className="spacer" />
        <span title={runId ?? snapshotId}>
          <Badge
            tone={
              (treeResult?.source ?? (runId ? 'WORKSPACE' : 'SNAPSHOT')) === 'WORKSPACE'
                ? 'info'
                : 'default'
            }
          >
            {treeResult
              ? treeResult.source === 'WORKSPACE'
                ? `工作区 gen-${treeResult.workspaceGeneration}`
                : '快照'
              : staleTreeResult
                ? `上一代 gen-${staleTreeResult.workspaceGeneration} · 正在读取 gen-${workspaceGeneration ?? '?'}`
                : treeError
                  ? runId
                    ? `工作区 gen-${workspaceGeneration ?? '?'} · 读取失败`
                    : '快照 · 读取失败'
                  : runId
                    ? `工作区 gen-${workspaceGeneration ?? '?'} · 加载中`
                    : '快照 · 加载中'}
          </Badge>
        </span>
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

      {staleTreeResult && (
        <div className="filepanel-stale" role="status">
          正在读取 gen-{workspaceGeneration ?? '?'}；下面仍是 gen-
          {staleTreeResult.workspaceGeneration} 的内容，暂不可点击。
        </div>
      )}

      <div className={`filepanel-tree ${staleTreeResult ? 'stale' : ''}`}>
        {treeLoading ? (
          <div className="empty" style={{ padding: 20 }} role="status">
            正在读取当前文件树…
          </div>
        ) : treeError ? (
          <div className="filepanel-error" role="alert">
            文件树读取失败：{treeError}
          </div>
        ) : shownTree && shownTree.entries.length === 0 ? (
          <div className="empty" style={{ padding: 20 }}>
            没有文件
          </div>
        ) : forceExpand && filtered.length === 0 ? (
          <div className="empty" style={{ padding: 20 }}>
            没有匹配“{filter.trim()}”的文件
          </div>
        ) : (
          sortedChildren(tree).map((n) => renderNode(n, 0))
        )}
      </div>

      {fileLoading && expectedFileOwner && (
        <div className="filepanel-viewer" aria-busy="true">
          <div className="filepanel-viewer-head">
            <code style={{ fontSize: 11 }}>{expectedFileOwner.path}</code>
            <span className="spacer" />
            <button onClick={closeFile} title="取消预览">
              ✕
            </button>
          </div>
          <div className="empty" style={{ padding: 14 }} role="status">
            正在读取文件…
          </div>
        </div>
      )}

      {fileError && expectedFileOwner && (
        <div className="filepanel-viewer">
          <div className="filepanel-viewer-head">
            <code style={{ fontSize: 11 }}>{expectedFileOwner.path}</code>
            <span className="spacer" />
            <button onClick={closeFile} title="收起">
              ✕
            </button>
          </div>
          <div className="filepanel-error" role="alert">
            文件读取失败：{fileError}
          </div>
        </div>
      )}

      {file && (
        <div className={`filepanel-viewer ${staleTreeResult ? 'stale' : ''}`}>
          <div className="filepanel-viewer-head">
            <code style={{ fontSize: 11 }}>{file.path}</code>
            <span className="spacer" />
            {staleTreeResult && <Badge tone="warn">上一代</Badge>}
            {file.changed && <Badge tone="ok">已改动</Badge>}
            <span style={{ color: 'var(--text-tertiary)', fontSize: 10.5 }}>{file.bytes} B</span>
            <button onClick={closeFile} title="收起">
              ✕
            </button>
          </div>
          <pre className="filepanel-code">
            {file.binary ? '（二进制文件，不显示内容）' : file.content}
            {file.truncated &&
              `\n\n… 已截断：只读取了前 ${file.bytes} B，其余内容未加载。用「刷新」重读，或在补丁审查里看完整改动。`}
          </pre>
        </div>
      )}
    </aside>
  );
}
