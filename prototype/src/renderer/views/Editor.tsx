import { useCallback, useEffect, useRef, useState } from 'react';
import { call } from '../bridge';
import { Badge, DiffView } from '../components/common';
import { CodeView } from './CodeView';

/**
 * 编辑器面板：多标签、只读、内容全部来自 files.read 的 IPC 投影。
 *
 * generation 纪律与 FileTreePanel 同源：读文件必须携带最后一次 files.tree
 * 确认的 generation；Agent 改完文件（refreshKey 变化）后整体重解析。
 * 读到 CONFLICT（generation 已变）时自动刷新一次来源再重试 —— 只一次，
 * 还冲突就把错误摆出来，不做无限重试。
 *
 * 这是查看器：用户改代码的唯一路径仍是任务 → 补丁 → 人工接受。
 * 二进制不显示、截断如实标注 —— 与文件树预览同一套诚实规则。
 */

interface LoadedFile {
  readonly path: string;
  readonly content: string;
  readonly bytes: number;
  readonly truncated: boolean;
  readonly binary: boolean;
  readonly changed: boolean;
  readonly source: 'SNAPSHOT' | 'WORKSPACE';
  readonly generation: number | null;
}

type TabState =
  | { kind: 'LOADING' }
  | { kind: 'READY'; file: LoadedFile }
  | { kind: 'ERROR'; message: string };

/**
 * 编辑器标签的两种身份（交互评审 v0.2 P2「diff 进编辑器」）：
 *   file —— 从 files.read 按 generation 门禁读取的只读文件；
 *   diff —— 补丁里某个文件的改动。内容是封存补丁的一份拷贝（补丁不可变，
 *           拷贝即事实），不走 files.read，也没有"刷新"—— 封存物没有新版本。
 * id 是标签的唯一身份：file 用路径本身，diff 用 `diff:` 前缀 ——
 * 同一个文件的"现状"与"改动"可以并排开着。
 */
export type EditorTab =
  | { readonly id: string; readonly kind: 'file'; readonly path: string; readonly pinned: boolean }
  | {
      readonly id: string;
      readonly kind: 'diff';
      readonly path: string;
      readonly pinned: boolean;
      readonly diff: string;
      readonly truncated: boolean;
    };

export function EditorPane({
  snapshotId,
  runId,
  refreshKey,
  tabs,
  active,
  onActivate,
  onClose,
  onPin,
  onCollapse,
}: {
  snapshotId: string;
  runId: string | null;
  /** Agent 改动落地后由外层递增，触发来源与内容重读 */
  refreshKey: number;
  tabs: readonly EditorTab[];
  /** 活动标签的 id（file 标签的 id 即路径） */
  active: string | null;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  /** 双击标签把预览固定下来（IDE 惯例），可选 —— 单测可不接线 */
  onPin?: (id: string) => void;
  /** 显式收起整个编辑器列（标签保留），可选 —— 单测可不接线 */
  onCollapse?: () => void;
}) {
  const [states, setStates] = useState<Map<string, TabState>>(new Map());
  // 竞态防护：来源/标签变化后，旧的异步结果不允许写回
  const epochRef = useRef(0);
  /*
   * in-flight 守卫：挂载时"来源初始化"与"激活标签"两个 effect 会同时想加载
   * 活动标签，双请求的结果互相覆盖（后到的赢，可能是过时的那个）。
   * 同一路径在途时不再发起第二次；来源变化会整体作废（epoch + 清空）。
   */
  const inflightRef = useRef<Set<string>>(new Set());

  const load = useCallback(
    async (path: string) => {
      if (inflightRef.current.has(path)) return;
      inflightRef.current.add(path);
      // epoch 代表"来源代"（快照/Run/Agent 改动），由来源 effect 递增；这里只读取
      const epoch = epochRef.current;
      setStates((m) => new Map(m).set(path, { kind: 'LOADING' }));
      const readOnce = async (): Promise<LoadedFile> => {
        const tree = await call('files.tree', { snapshotId, ...(runId ? { runId } : {}) });
        const res = await call('files.read', {
          snapshotId,
          path,
          ...(runId ? { runId } : {}),
          expectedGeneration: tree.generation,
        });
        return res as LoadedFile;
      };
      try {
        let file: LoadedFile;
        try {
          file = await readOnce();
        } catch (err) {
          // generation 在 tree 与 read 之间变了：刷新来源重试一次，仍失败就如实报错
          if ((err as Error).message.includes('generation')) file = await readOnce();
          else throw err;
        }
        if (epochRef.current !== epoch) return;
        setStates((m) => new Map(m).set(path, { kind: 'READY', file }));
      } catch (err) {
        if (epochRef.current !== epoch) return;
        setStates((m) => new Map(m).set(path, { kind: 'ERROR', message: (err as Error).message }));
      } finally {
        inflightRef.current.delete(path);
      }
    },
    [snapshotId, runId],
  );

  // 来源变化（快照/Run/Agent 改动）→ 全部标签内容作废重读；只主动加载活动标签
  useEffect(() => {
    epochRef.current += 1;
    inflightRef.current.clear();
    setStates(new Map());
    const tab = tabs.find((t) => t.id === active);
    if (tab?.kind === 'file') void load(tab.path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshotId, runId, refreshKey]);

  // 激活一个还没内容的 file 标签时加载；diff 标签自带内容，不走 IPC
  useEffect(() => {
    const tab = tabs.find((t) => t.id === active);
    if (tab?.kind === 'file' && !states.has(tab.path)) void load(tab.path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, tabs]);

  const activeTab = active !== null ? tabs.find((t) => t.id === active) ?? null : null;
  const activeState = activeTab?.kind === 'file' ? states.get(activeTab.path) : undefined;
  const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1);

  return (
    <section className="editorpane" aria-label="代码编辑器（只读）">
      <div className="editorpane-drag" aria-hidden="true" />
      <div className="editorpane-tabs">
        <div className="editorpane-tablist" role="tablist">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            role="tab"
            aria-selected={tab.id === active}
            className={`editorpane-tab ${tab.id === active ? 'active' : ''} ${tab.pinned ? '' : 'preview'}`}
            title={
              tab.kind === 'diff'
                ? `补丁 diff · ${tab.path}`
                : tab.pinned
                  ? tab.path
                  : `${tab.path}（预览 —— 双击固定；打开别的文件会复用这个位置）`
            }
            onClick={() => onActivate(tab.id)}
            onDoubleClick={() => {
              if (!tab.pinned) onPin?.(tab.id);
            }}
          >
            <span className="editorpane-tab-name">
              {tab.kind === 'diff' ? `± ${basename(tab.path)}` : basename(tab.path)}
            </span>
            <button
              className="editorpane-tab-close"
              aria-label={`关闭 ${tab.kind === 'diff' ? `${tab.path} 的 diff` : tab.path}`}
              onClick={(e) => {
                e.stopPropagation();
                onClose(tab.id);
              }}
            >
              ✕
            </button>
          </div>
        ))}
        </div>
        {onCollapse && (
          <button
            className="editorpane-collapse"
            title="收起编辑器（标签保留）"
            aria-label="收起编辑器"
            onClick={onCollapse}
          >
            ⇥
          </button>
        )}
      </div>

      {activeTab && (
        <div className="editorpane-pathbar">
          <code>{activeTab.path}</code>
          <span className="spacer" />
          {activeTab.kind === 'diff' && (
            <span title="封存补丁的改动内容 —— 补丁不可变，没有可刷新的新版本">
              <Badge tone="info">补丁 diff</Badge>
            </span>
          )}
          {activeState?.kind === 'READY' && (
            <>
              {activeState.file.source === 'WORKSPACE' && activeState.file.changed && <Badge tone="ok">已改动</Badge>}
              <Badge tone={activeState.file.source === 'WORKSPACE' ? 'info' : 'default'}>
                {activeState.file.source === 'WORKSPACE'
                  ? `工作区 gen-${activeState.file.generation}`
                  : '快照'}
              </Badge>
              <span className="editorpane-bytes">{activeState.file.bytes} B</span>
            </>
          )}
          {activeTab.kind === 'file' && (
            <button onClick={() => void load(activeTab.path)} title="重新读取">
              刷新
            </button>
          )}
        </div>
      )}

      <div className="editorpane-body">
        {!activeTab && (
          <p className="editorpane-empty" role="status">
            从文件树打开一个文件。这里是只读视图 —— 改代码的唯一路径仍是任务 → 补丁 → 你来接受。
          </p>
        )}
        {activeTab?.kind === 'diff' && (
          <>
            {activeTab.truncated && (
              <div className="editorpane-truncated" role="status">
                diff 已截断 —— 完整改动请在补丁审查里导出后查看。
              </div>
            )}
            <DiffView diff={activeTab.diff} />
          </>
        )}
        {activeTab?.kind === 'file' && (!activeState || activeState.kind === 'LOADING') && (
          <p className="editorpane-empty" role="status">
            正在读取 {activeTab.path}…
          </p>
        )}
        {activeTab?.kind === 'file' && activeState?.kind === 'ERROR' && (
          <div className="filepanel-error" role="alert">
            文件读取失败：{activeState.message}
          </div>
        )}
        {activeTab?.kind === 'file' && activeState?.kind === 'READY' && activeState.file.binary && (
          <p className="editorpane-empty" role="status">
            二进制文件（{activeState.file.bytes} B），不显示内容。
          </p>
        )}
        {activeTab?.kind === 'file' && activeState?.kind === 'READY' && !activeState.file.binary && (
          <>
            {activeState.file.truncated && (
              <div className="editorpane-truncated" role="status">
                已截断：只读取了文件前 {activeState.file.content.length} 字符（共 {activeState.file.bytes} B），
                其余内容未加载 —— 完整改动请看补丁审查。
              </div>
            )}
            <CodeView path={activeState.file.path} content={activeState.file.content} />
          </>
        )}
      </div>
    </section>
  );
}
