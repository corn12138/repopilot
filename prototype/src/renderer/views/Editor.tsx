import { useCallback, useEffect, useRef, useState } from 'react';
import { call } from '../bridge';
import { Badge } from '../components/common';
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

export function EditorPane({
  snapshotId,
  runId,
  refreshKey,
  tabs,
  active,
  onActivate,
  onClose,
}: {
  snapshotId: string;
  runId: string | null;
  /** Agent 改动落地后由外层递增，触发来源与内容重读 */
  refreshKey: number;
  tabs: readonly string[];
  active: string | null;
  onActivate: (path: string) => void;
  onClose: (path: string) => void;
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
    if (active && tabs.includes(active)) void load(active);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshotId, runId, refreshKey]);

  // 激活一个还没内容的标签时加载
  useEffect(() => {
    if (active && tabs.includes(active) && !states.has(active)) void load(active);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, tabs]);

  const activeState = active ? states.get(active) : undefined;
  const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1);

  return (
    <section className="editorpane" aria-label="代码编辑器（只读）">
      <div className="editorpane-drag" aria-hidden="true" />
      <div className="editorpane-tabs" role="tablist">
        {tabs.map((path) => (
          <div
            key={path}
            role="tab"
            aria-selected={path === active}
            className={`editorpane-tab ${path === active ? 'active' : ''}`}
            title={path}
            onClick={() => onActivate(path)}
          >
            <span className="editorpane-tab-name">{basename(path)}</span>
            <button
              className="editorpane-tab-close"
              aria-label={`关闭 ${path}`}
              onClick={(e) => {
                e.stopPropagation();
                onClose(path);
              }}
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      {active && (
        <div className="editorpane-pathbar">
          <code>{active}</code>
          <span className="spacer" />
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
          <button onClick={() => active && void load(active)} title="重新读取">
            刷新
          </button>
        </div>
      )}

      <div className="editorpane-body">
        {!active && (
          <p className="editorpane-empty" role="status">
            从文件树打开一个文件。这里是只读视图 —— 改代码的唯一路径仍是任务 → 补丁 → 你来接受。
          </p>
        )}
        {active && (!activeState || activeState.kind === 'LOADING') && (
          <p className="editorpane-empty" role="status">
            正在读取 {active}…
          </p>
        )}
        {active && activeState?.kind === 'ERROR' && (
          <div className="filepanel-error" role="alert">
            文件读取失败：{activeState.message}
          </div>
        )}
        {active && activeState?.kind === 'READY' && activeState.file.binary && (
          <p className="editorpane-empty" role="status">
            二进制文件（{activeState.file.bytes} B），不显示内容。
          </p>
        )}
        {active && activeState?.kind === 'READY' && !activeState.file.binary && (
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
