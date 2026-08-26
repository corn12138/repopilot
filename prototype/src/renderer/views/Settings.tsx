import { useEffect, useRef, useState } from 'react';
import type { DoctorCheck, ModelConnectionProfile } from '@shared/domain';
import type { DiskUsage, PurgeSummaryView, RetentionPolicyView } from '@shared/protocol';
import { call } from '../bridge';
import { Badge, Banner, Card, ConfirmAction, DoctorBadge } from '../components/common';

export function SettingsView({
  checks,
  profiles,
  secureStorage,
  credentialStore,
  credentialStoreDetail,
  onProfilesChanged,
  onRefresh,
  onError,
  focusSection = null,
}: {
  checks: DoctorCheck[];
  profiles: ModelConnectionProfile[];
  secureStorage: boolean;
  credentialStore: 'ABSENT' | 'OK' | 'UNREADABLE';
  credentialStoreDetail: string | null;
  onProfilesChanged: (profiles: ModelConnectionProfile[]) => void;
  onRefresh: () => Promise<void>;
  onError: (err: unknown) => void;
  /** 从别处（如侧栏历史折叠的清理入口）跳进来时，滚动到指定卡片 */
  focusSection?: 'retention' | null;
}) {
  return (
    <>
      <Card
        title="环境自检"
        hint="Environment Doctor"
        right={<button onClick={() => void onRefresh()}>重新检查</button>}
      >
        {checks.map((c) => (
          <div key={c.checkId} className="checkline">
            <DoctorBadge status={c.status} />
            <span style={{ minWidth: 120 }}>{c.label}</span>
            <span className="detail">{c.detail}</span>
            {c.remediation && (
              <>
                <span className="spacer" />
                <span style={{ color: 'var(--state-warning-fg)', fontSize: 11 }}>{c.remediation}</span>
              </>
            )}
          </div>
        ))}
      </Card>

      <Card title="模型连接" hint="BYOK · 填完即生效，不需要重启">
        {!secureStorage && (
          <Banner tone="warn">
            系统钥匙串不可用，应用内保存凭据已禁用。可以改用环境变量提供 API Key。
          </Banner>
        )}

        {/*
          "读不出来"与"没配过"必须分开说。两者都会让下面每个 provider 显示成
          没有凭据，但一个要你去填，另一个是你填过的东西现在解不开 —— 而且这种状态下
          保存新 key 会覆盖掉那份其实还在的密文，所以写入被 Main 拒绝了。
        */}
        {credentialStore === 'UNREADABLE' && (
          <div role="alert">
            <Banner tone="err">
              <strong>凭据文件存在，但读不出来 —— 这不等于你没配过。</strong>
              {credentialStoreDetail && (
                <div style={{ marginTop: 4 }}>{credentialStoreDetail}</div>
              )}
              <div style={{ marginTop: 6 }}>
                为避免用一把新 key 覆盖掉其余仍在文件里的凭据，保存与删除都已被拒绝。
                常见原因是换了机器或钥匙串被清空；确认旧凭据不再需要后，删除该文件即可重新开始。
              </div>
            </Banner>
          </div>
        )}

        <ProviderGroup
          label="已配置"
          profiles={profiles.filter((p) => p.enabled)}
          empty="还没有配好任何连接 —— 在下面挑一个填 API Key 即可。"
          {...{ secureStorage, onProfilesChanged, onError }}
        />
        <ProviderGroup
          label="官方 API"
          profiles={profiles.filter((p) => !p.enabled && p.kind === 'OFFICIAL')}
          {...{ secureStorage, onProfilesChanged, onError }}
        />
        <ProviderGroup
          label="聚合 / 中转"
          hint="你的代码上下文会经过这些第三方"
          profiles={profiles.filter((p) => !p.enabled && p.kind === 'RELAY')}
          {...{ secureStorage, onProfilesChanged, onError }}
        />
        <ProviderGroup
          label="自定义"
          profiles={profiles.filter((p) => !p.enabled && p.kind === 'CUSTOM')}
          {...{ secureStorage, onProfilesChanged, onError }}
        />

        <AddProviderForm onProfilesChanged={onProfilesChanged} onError={onError} />

        <div className="help" style={{ marginTop: 12 }}>
          凭据优先级：应用内录入 &gt; 环境变量。应用内的那份由 macOS 钥匙串加密保管，
          界面只显示末四位，完整值不会回传给界面、不写日志、不进事件。
        </div>
      </Card>

      <RetentionCard onError={onError} autoFocus={focusSection === 'retention'} />
    </>
  );
}

// ---------------------------------------------------------------------------
// 数据保留
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** `diskUsage()` 的域名（小写目录名）。 */
const DOMAIN_LABEL: Record<string, string> = {
  runs: 'Run 证据（事件/状态/补丁）',
  snapshots: '导入快照',
  workspaces: '隔离工作区',
  artifacts: '导出产物',
};

/**
 * `PurgeItemView.domain` 的域名（大写枚举）—— 与上面那张表的键空间**不相交**。
 * 用错一张，确认框里就会打出裸的 RUN_EVIDENCE，而它上方几行的用量徽章
 * 对同一批数据写的是「Run 证据（事件/状态/补丁）」。删除前必须读的那段话，
 * 不该是两套词汇。
 */
const PURGE_DOMAIN_LABEL: Record<string, string> = {
  RUN_EVIDENCE: 'Run 证据（事件/状态/补丁）',
  SNAPSHOT: '导入快照',
  WORKSPACE: '隔离工作区',
  ARTIFACT: '导出产物',
};

/**
 * 清理预演的渲染。
 *
 * 只显示 Core 真的算出来的东西：条数、字节数、逐项目标。
 * 一个字的估算都没有 —— 猜出来的影响预览比没有更糟，因为它同样会被当成承诺。
 */
function SweepPreview({ summary }: { summary: PurgeSummaryView }) {
  const willDelete = summary.items.filter((i) => i.outcome === 'WOULD_DELETE');
  const byDomain = new Map<string, number>();
  for (const item of willDelete) byDomain.set(item.domain, (byDomain.get(item.domain) ?? 0) + 1);

  if (willDelete.length === 0) {
    return (
      <>
        <strong>
          {summary.status === 'INCOMPLETE'
            ? '在预演扫到的范围内没有要删除的东西 —— 但这次预演没有扫完。'
            : '按当前策略，这次清理不会删除任何东西。'}
        </strong>
        <div style={{ marginTop: 4 }}>
          已扫描 {summary.scanned} 项，其中没有到期或失去引用的项。
        </div>
        {/*
          截断必须报数。少了这一句，一次被预算截断、根本没扫到快照与 artifact 的预演，
          会被读成"全部检查过，什么都不用删" —— 然后确认键下去真的删掉没预演到的东西。
        */}
        {summary.status === 'INCOMPLETE' && (
          <div style={{ marginTop: 4 }}>
            预演在扫完之前就停了（{summary.incompleteReason}）：**未被扫到的部分没有结论**，
            实际清理仍可能删除它们。
          </div>
        )}
      </>
    );
  }

  return (
    <>
      <strong>
        将删除 {willDelete.length} 项，释放 {formatBytes(summary.bytesFreed)}。此操作不可撤销。
      </strong>
      <div style={{ marginTop: 4 }}>
        已扫描 {summary.scanned} 项 ·{' '}
        {[...byDomain.entries()]
          .map(([domain, count]) => `${PURGE_DOMAIN_LABEL[domain] ?? domain} ${count}`)
          .join('、')}
      </div>
      {summary.status === 'INCOMPLETE' && (
        <div style={{ marginTop: 4 }}>
          预演本身不完整（{summary.incompleteReason}）—— 实际清理可能与这份清单不同。
        </div>
      )}
      {byDomain.has('RUN_EVIDENCE') && (
        <div style={{ marginTop: 4 }}>
          其中 {byDomain.get('RUN_EVIDENCE')} 个 Run 的证据会被删除，它们将从运行列表里消失。
        </div>
      )}
      <ul className="preview-list">
        {willDelete.map((item) => (
          <li key={`${item.domain}-${item.target}`}>
            {PURGE_DOMAIN_LABEL[item.domain] ?? item.domain} {item.target} ·{' '}
            {formatBytes(item.bytesFreed)}
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * 保留策略此前只有 Core 侧的 policy + sweep，没有任何界面出口 ——
 * 用户既看不到磁盘被占了多少，也改不了保留期、触发不了清理。
 * 这里的三条诚实规则：
 *   - 占用是真实扫出来的数字，不是估计；
 *   - 清理结果必须报数（扫了多少、删了多少、释放多少），INCOMPLETE 必须醒目；
 *   - 单项失败逐条列出原因 —— 静默跳过和静默删除是同一类问题。
 */
function RetentionCard({
  onError,
  autoFocus = false,
}: {
  onError: (err: unknown) => void;
  /** 从侧栏历史折叠的清理入口跳进来：滚到这张卡，别让用户在设置页里找 */
  autoFocus?: boolean;
}) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const didFocusRef = useRef(false);
  const [policy, setPolicy] = useState<RetentionPolicyView | null>(null);
  useEffect(() => {
    // 等 policy 到位（卡片长到最终高度）再滚，且只滚一次；
    // jsdom 没有 scrollIntoView —— 可选调用，真实渲染器里生效
    if (!autoFocus || didFocusRef.current || policy === null) return;
    didFocusRef.current = true;
    cardRef.current?.scrollIntoView?.({ block: 'start' });
  }, [autoFocus, policy]);
  const [usage, setUsage] = useState<DiskUsage>({});
  const [summary, setSummary] = useState<PurgeSummaryView | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [evidenceDays, setEvidenceDays] = useState('');
  const [graceMinutes, setGraceMinutes] = useState('');
  const [busy, setBusy] = useState(false);

  const adopt = (r: {
    policy: RetentionPolicyView;
    usage: DiskUsage;
    lastSummary?: PurgeSummaryView | null;
    summary?: PurgeSummaryView;
  }): void => {
    setPolicy(r.policy);
    setUsage(r.usage);
    setEvidenceDays(String(r.policy.evidenceDays));
    setGraceMinutes(String(r.policy.workspaceGraceMinutes));
    const s = r.summary ?? r.lastSummary;
    if (s !== undefined) setSummary(s);
  };

  useEffect(() => {
    let alive = true;
    call('retention.get', {})
      .then((r) => {
        if (alive) adopt(r);
      })
      .catch(() => {
        // 拉不到就明说，不装作没有这块功能
        if (alive) setLoadFailed(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  const savePolicy = async () => {
    const days = Number(evidenceDays);
    const grace = Number(graceMinutes);
    if (!Number.isInteger(days) || days < 1 || !Number.isInteger(grace) || grace < 0) {
      onError(new Error('保留期必须是正整数天数；宽限期必须是非负整数分钟'));
      return;
    }
    setBusy(true);
    try {
      adopt(await call('retention.update', { evidenceDays: days, workspaceGraceMinutes: grace }));
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  const sweepNow = async () => {
    setBusy(true);
    setPreview(null);
    try {
      adopt(await call('retention.sweepNow', {}));
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  /*
   * 清理预演。在此之前，想知道「立即清理」会删掉什么的唯一办法是**真的删一次**。
   * 预演走的是与真删完全相同的判定路径，只跳过 rmSync —— 所以这里显示的不是估算，
   * 是"按当前事实，这一次会删掉这些"。
   */
  const [preview, setPreview] = useState<PurgeSummaryView | null>(null);
  const [previewFailed, setPreviewFailed] = useState<string | null>(null);

  const loadPreview = async (overrides: { evidenceDays?: number; workspaceGraceMinutes?: number } = {}) => {
    setPreview(null);
    setPreviewFailed(null);
    try {
      const r = await call('retention.preview', overrides);
      setPreview(r.summary);
    } catch (err) {
      // 预演失败时**不能**让确认按钮可用：那等于让用户在不知道后果的情况下按下去。
      setPreviewFailed(err instanceof Error ? err.message : '预演失败');
    }
  };

  const totalBytes = Object.values(usage).reduce((n, d) => n + d.bytes, 0);
  const dirty =
    policy !== null &&
    (evidenceDays !== String(policy.evidenceDays) || graceMinutes !== String(policy.workspaceGraceMinutes));

  return (
    <div ref={cardRef}>
    <Card
      title="数据保留"
      hint="Retention"
      right={
        <ConfirmAction
          label="立即清理…"
          confirmLabel="确认删除"
          busyLabel="清理中…"
          busy={busy}
          disabled={!policy}
          tone="err"
          /*
           * 三态。以前这里用「非空即可确认」，于是预演失败返回的错误节点让守卫失效 ——
           * 横幅写着"已阻止执行"，底下的确认按钮却是活的。
           */
          consequence={
            previewFailed !== null
              ? {
                  kind: 'blocked',
                  reason: (
                    <strong>
                      无法预演这次清理：{previewFailed} —— 已阻止在不知道后果的情况下执行。
                    </strong>
                  ),
                }
              : preview === null
                ? { kind: 'pending' }
                : { kind: 'ready', detail: <SweepPreview summary={preview} /> }
          }
          // 策略一变，已展开的后果就作废：不能拿旧策略算出来的清单去确认新策略的清理。
          armKey={policy ? `${policy.evidenceDays}:${policy.workspaceGraceMinutes}` : 'no-policy'}
          onArm={() => void loadPreview()}
          onConfirm={() => void sweepNow()}
        />
      }
    >
      {loadFailed && <Banner tone="err">保留策略读取失败 —— 这块功能当前不可用，不是没有数据。</Banner>}

      {policy && (
        <>
          <div className="row wrap" style={{ marginBottom: 12 }}>
            <Badge tone="info">受管数据共 {formatBytes(totalBytes)}</Badge>
            {Object.entries(usage).map(([domain, d]) => (
              <Badge key={domain}>
                {DOMAIN_LABEL[domain] ?? domain} {formatBytes(d.bytes)} · {d.entries} 项
              </Badge>
            ))}
          </div>

          <div className="field">
            <label>Run 证据保留天数（事件、状态快照、补丁）</label>
            <div className="row">
              <input
                style={{ maxWidth: 120 }}
                value={evidenceDays}
                disabled={busy}
                onChange={(e) => setEvidenceDays(e.target.value)}
              />
              <span style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>天</span>
            </div>
          </div>

          <div className="field">
            <label>终态 Run 的工作区宽限期（此后隔离副本可被清理）</label>
            <div className="row">
              <input
                style={{ maxWidth: 120 }}
                value={graceMinutes}
                disabled={busy}
                onChange={(e) => setGraceMinutes(e.target.value)}
              />
              <span style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>分钟</span>
              <span className="spacer" />
              {dirty && (
                <button className="primary" disabled={busy} onClick={() => void savePolicy()}>
                  保存策略
                </button>
              )}
            </div>
            <div className="help">
              单轮清理上限 {policy.maxItemsPerSweep} 项 / {Math.round(policy.maxDurationMs / 1000)}s ——
              超出的留给下一轮，绝不为"清干净"而无界扫描。被引用的数据（进行中的 Run、
              待审查的补丁）无论过期与否都不会删。
            </div>
          </div>

          {summary && (
            <>
              <Banner tone={summary.status === 'COMPLETE' ? 'info' : 'warn'}>
                <strong>
                  上次清理（{summary.status === 'COMPLETE' ? '完整' : '未完成'}）：
                </strong>
                扫描 {summary.scanned} 项，删除 {summary.deleted} 项，释放{' '}
                {formatBytes(summary.bytesFreed)}。
                {summary.incompleteReason && (
                  <div style={{ marginTop: 4 }}>未完成原因：{summary.incompleteReason}</div>
                )}
              </Banner>
              {summary.items.some((i) => i.outcome === 'FAILED') && (
                <Banner tone="err">
                  有 {summary.items.filter((i) => i.outcome === 'FAILED').length} 项删除失败 ——
                  失败的残留必须可见，不能当作已清理。
                </Banner>
              )}
              {summary.items.length > 0 && (
                <details className="toolcall" style={{ marginTop: 8 }}>
                  <summary>
                    <span style={{ color: 'var(--text-secondary)' }}>逐项结果（{summary.items.length}）</span>
                  </summary>
                  <div className="body">
                    <pre className="output" style={{ maxHeight: 220 }}>
                      {summary.items
                        .map(
                          (i) =>
                            `${i.outcome.padEnd(15)} ${i.domain.padEnd(12)} ${i.target}` +
                            `${i.bytesFreed ? ` (${formatBytes(i.bytesFreed)})` : ''}${i.reason ? ` —— ${i.reason}` : ''}`,
                        )
                        .join('\n')}
                    </pre>
                  </div>
                </details>
              )}
            </>
          )}
        </>
      )}
    </Card>
    </div>
  );
}

function ProviderGroup({
  label,
  hint,
  profiles,
  empty,
  secureStorage,
  onProfilesChanged,
  onError,
}: {
  label: string;
  hint?: string;
  profiles: ModelConnectionProfile[];
  empty?: string;
  secureStorage: boolean;
  onProfilesChanged: (p: ModelConnectionProfile[]) => void;
  onError: (err: unknown) => void;
}) {
  if (profiles.length === 0 && !empty) return null;
  return (
    <>
      <div className="section-label" style={{ padding: '12px 2px 6px' }}>
        {label}
        {hint && <span style={{ textTransform: 'none', marginLeft: 8, fontWeight: 400 }}>{hint}</span>}
      </div>
      {profiles.length === 0 ? (
        <div style={{ color: 'var(--text-tertiary)', fontSize: 11.5, padding: '2px 4px 6px' }}>{empty}</div>
      ) : (
        profiles.map((p) => (
          <ProviderRow
            key={p.profileId}
            profile={p}
            canStore={secureStorage}
            onProfilesChanged={onProfilesChanged}
            onError={onError}
          />
        ))
      )}
    </>
  );
}

/** 任意 OpenAI / Anthropic 兼容端点都能自己加进来 */
function AddProviderForm({
  onProfilesChanged,
  onError,
}: {
  onProfilesChanged: (p: ModelConnectionProfile[]) => void;
  onError: (err: unknown) => void;
}) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    id: '',
    name: '',
    api: '',
    wire: 'openai' as 'openai' | 'anthropic',
    models: '',
  });
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      const r = await call('model.addProvider', {
        id: form.id,
        name: form.name || form.id,
        api: form.api,
        wire: form.wire,
        models: form.models
          .split(/[,\n]/)
          .map((m) => m.trim())
          .filter(Boolean),
      });
      onProfilesChanged(r.profiles);
      setForm({ id: '', name: '', api: '', wire: 'openai', models: '' });
      setOpen(false);
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button style={{ marginTop: 12, color: 'var(--accent-interactive)' }} onClick={() => setOpen(true)}>
        + 添加自定义 Provider
      </button>
    );
  }

  return (
    <div className="provider" style={{ marginTop: 12 }}>
      <div className="provider-body" style={{ paddingLeft: 12, paddingTop: 14 }}>
        <div className="field">
          <label>标识 / 名称</label>
          <div className="row">
            <input
              value={form.id}
              placeholder="my-relay"
              onChange={(e) => setForm({ ...form, id: e.target.value })}
            />
            <input
              value={form.name}
              placeholder="显示名称（可选）"
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>
          <div className="help">与内置 provider 重名会被拒绝。</div>
        </div>

        <div className="field">
          <label>API 地址</label>
          <div className="row">
            <input
              value={form.api}
              placeholder="https://your-relay.com/v1"
              onChange={(e) => setForm({ ...form, api: e.target.value })}
            />
            <select
              value={form.wire}
              onChange={(e) => setForm({ ...form, wire: e.target.value as 'openai' | 'anthropic' })}
            >
              <option value="openai">OpenAI 协议</option>
              <option value="anthropic">Anthropic 协议</option>
            </select>
          </div>
          <div className="help">
            要带版本路径。只填域名时自动补 <code>/v1</code>；带路径的原样保留
            （智谱是 <code>/api/paas/v4</code>、火山是 <code>/api/v3</code>）。
          </div>
        </div>

        <div className="field" style={{ marginBottom: 10 }}>
          <label>模型清单（逗号或换行分隔，可留空后面手填）</label>
          <textarea
            value={form.models}
            placeholder="gpt-4o, claude-sonnet-4-5"
            onChange={(e) => setForm({ ...form, models: e.target.value })}
            style={{ minHeight: 48 }}
          />
        </div>

        <div className="row">
          <span className="spacer" />
          <button onClick={() => setOpen(false)}>取消</button>
          <button
            className="primary"
            disabled={busy || !form.id.trim() || !form.api.trim()}
            onClick={() => void submit()}
          >
            添加
          </button>
        </div>
      </div>
    </div>
  );
}

function ProviderRow({
  profile,
  canStore,
  onProfilesChanged,
  onError,
}: {
  profile: ModelConnectionProfile;
  canStore: boolean;
  onProfilesChanged: (profiles: ModelConnectionProfile[]) => void;
  onError: (err: unknown) => void;
}) {
  const [open, setOpen] = useState(false);
  const [keyInput, setKeyInput] = useState('');
  const [baseUrl, setBaseUrl] = useState(profile.baseUrlOverride);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const [modelDraft, setModelDraft] = useState(profile.modelId);
  /** 用户主动选了「自定义…」。modelId 本来就不在清单里时不需要它也会进自定义态。 */
  const [pickedCustom, setPickedCustom] = useState(false);
  const modelBox = useRef<HTMLInputElement>(null);

  /*
   * updateProfile 返回的新 profile 替换掉旧的之后，把输入框拉回真值。
   *
   * 这里以前是 defaultValue：ProviderRow 按 profileId 做 key，profileId 不变就
   * 永远不重挂载，于是下拉框选了 deepseek-reasoner、输入框还留着 deepseek-chat，
   * 之后随便点一下输入框再移开，onBlur 就拿着那个旧值把模型悄悄改回去了。
   */
  useEffect(() => {
    setModelDraft(profile.modelId);
    setPickedCustom(false);
  }, [profile.modelId]);

  const sourceBadge =
    profile.credentialSource === 'APP' ? (
      <Badge tone="ok">已配置</Badge>
    ) : profile.credentialSource === 'ENV' ? (
      <Badge tone="info">环境变量</Badge>
    ) : (
      <Badge>未配置</Badge>
    );

  const saveKey = async (value: string) => {
    setBusy(true);
    setResult(null);
    try {
      const r = await call('model.setKey', { profileId: profile.profileId, apiKey: value });
      onProfilesChanged(r.profiles);
      setKeyInput('');
      setResult({ ok: true, text: value.trim() ? 'API Key 已保存并生效' : '已删除应用内凭据' });
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  const updateProfile = async (patch: { modelId?: string; baseUrlOverride?: string }) => {
    setBusy(true);
    setResult(null);
    try {
      const r = await call('model.updateProfile', { profileId: profile.profileId, ...patch });
      onProfilesChanged(r.profiles);
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  // 生效值不在清单里（自定义 provider、中转站的模型名）时天然就是自定义态
  const customModel = pickedCustom || !profile.availableModels.includes(profile.modelId);
  const dirtyModel = modelDraft.trim() !== profile.modelId && modelDraft.trim() !== '';

  /** 空输入回弹成当前值，不产生一次无意义的写盘；没变也不写 */
  const commitModel = (raw: string) => {
    const next = raw.trim();
    if (!next || next === profile.modelId) {
      setModelDraft(profile.modelId);
      return;
    }
    void updateProfile({ modelId: next });
  };

  const test = async () => {
    setBusy(true);
    setResult(null);
    try {
      const r = await call('model.testProfile', { profileId: profile.profileId });
      setResult({
        ok: r.ok,
        text: `${r.ok ? '✓' : '✗'} ${r.detail}${r.latencyMs ? ` (${r.latencyMs}ms)` : ''}`,
      });
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="provider">
      {/*
        展开头以前是 `div onClick` —— 鼠标能用，Tab 到不了，读屏也不知道这里能展开。
        改成真 button + aria-expanded/aria-controls 后，键盘与辅助技术走的是同一条路径。
        「测试连接」必须是它的兄弟节点而不是子节点：button 里嵌 button 是非法结构，
        之前靠 stopPropagation 掩盖的正是这个问题。
      */}
      <div className="provider-head">
        <button
          type="button"
          className="provider-toggle"
          aria-expanded={open}
          aria-controls={`provider-body-${profile.profileId}`}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="tree-caret">{open ? '▾' : '▸'}</span>
          {sourceBadge}
          <strong style={{ fontSize: 12.5, minWidth: 110 }}>{profile.label}</strong>
          <code style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
            {profile.modelId || '未选模型'}
          </code>
          <Badge>{profile.wire}</Badge>
          {profile.kind === 'CUSTOM' && <Badge tone="purple">自定义</Badge>}
          {profile.isRelay && <Badge tone="warn">经第三方</Badge>}
          {profile.credentialHint && (
            <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>
              {profile.credentialHint}
            </span>
          )}
          <span className="spacer" />
        </button>
        <button
          disabled={!profile.enabled || busy}
          aria-busy={busy}
          onClick={() => void test()}
        >
          {busy ? '测试中…' : '测试连接'}
        </button>
      </div>

      {result && (
        <div
          style={{
            fontSize: 11.5,
            fontFamily: 'var(--font-mono)',
            padding: '4px 12px 6px 30px',
            color: result.ok ? 'var(--state-verified-fg)' : 'var(--state-failed-fg)',
            wordBreak: 'break-word',
          }}
        >
          {result.text}
        </div>
      )}

      {open && (
        <div className="provider-body" id={`provider-body-${profile.profileId}`}>
          <div className="field">
            <label>
              API Key
              {profile.credentialSource === 'ENV' && (
                <span style={{ color: 'var(--text-tertiary)' }}>
                  {' '}
                  · 当前用的是环境变量 {profile.credentialEnvVar}，在这里填会覆盖它
                </span>
              )}
            </label>
            <div className="row">
              <input
                type="password"
                value={keyInput}
                disabled={!canStore || busy}
                placeholder={profile.credentialSource === 'APP' ? '已保存，填新值可替换' : 'sk-…'}
                onChange={(e) => setKeyInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && keyInput.trim()) void saveKey(keyInput);
                }}
              />
              <button
                className="primary"
                disabled={!canStore || busy || !keyInput.trim()}
                onClick={() => void saveKey(keyInput)}
              >
                保存
              </button>
              {profile.credentialSource === 'APP' && (
                <ConfirmAction
                  label="删除…"
                  confirmLabel="确认删除凭据"
                  busyLabel="删除中…"
                  busy={busy}
                  tone={profile.fallbackSource === 'ENV' ? 'warn' : 'err'}
                  /*
                   * 唯一真正重要的事实：删完之后掉到哪。这不是猜的 ——
                   * Core 的 resolveKeySource 会无副作用地把 fallback 一起算出来。
                   */
                  armKey={`${profile.providerId}:${profile.credentialHint ?? ''}`}
                  consequence={{
                    kind: 'ready',
                    detail:
                      profile.fallbackSource === 'ENV' ? (
                      <>
                        <strong>
                          删除后 {profile.label} 会改用环境变量 {profile.fallbackEnvVar} 里的 Key。
                        </strong>
                          <div style={{ marginTop: 4 }}>
                            连接仍然可用，但换成了**另一把** Key —— 可能对应另一个账号与另一份账单。
                            应用内这一份（{profile.credentialHint}）删掉后需要重新粘贴才能找回。
                          </div>
                        </>
                      ) : (
                        <>
                          <strong>删除后 {profile.label} 将没有任何可用凭据，连接会被禁用。</strong>
                          <div style={{ marginTop: 4 }}>
                            没有环境变量可以接手（
                            {profile.credentialEnvVars.length > 0
                              ? `${profile.credentialEnvVars.join(' / ')} 都未设置`
                              : '该 provider 没有可用的环境变量入口'}
                            ）。 正在使用这个 provider 的运行会在下一次模型调用时失败 ——
                            路由在任务创建时就已冻结，不会自动换到别的 provider。删掉的明文需要重新粘贴才能找回。
                          </div>
                        </>
                      ),
                  }}
                  onConfirm={() => void saveKey('')}
                />
              )}
            </div>
            <div className="help">
              {profile.docUrl ? (
                <>
                  去 <span style={{ color: 'var(--accent-interactive)' }}>{safeHost(profile.docUrl)}</span> 获取。
                </>
              ) : null}
              保存后立即生效，不用重启。
            </div>
          </div>

          <div className="field">
            <label>模型</label>
            <div className="row">
              <select
                value={customModel ? '__custom' : profile.modelId}
                disabled={busy}
                onChange={(e) => {
                  // 「自定义…」以前是个死选项：onChange 把它挡掉，什么也没发生，
                  // 下拉框又被 value 拉回原值 —— 看上去就是"选不动"。
                  // 现在它是一个真的动作：进自定义态，焦点交给右边的输入框，
                  // 当前 model id 全选好当编辑起点。
                  if (e.target.value === '__custom') {
                    setPickedCustom(true);
                    modelBox.current?.focus();
                    modelBox.current?.select();
                    return;
                  }
                  setPickedCustom(false);
                  void updateProfile({ modelId: e.target.value });
                }}
              >
                {profile.availableModels.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
                <option value="__custom">自定义…</option>
              </select>
              <input
                ref={modelBox}
                style={{ flex: 1 }}
                value={modelDraft}
                disabled={busy}
                placeholder="填写精确 model id"
                onChange={(e) => setModelDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitModel(modelDraft);
                }}
                onBlur={() => commitModel(modelDraft)}
              />
            </div>
            <div className="help">
              下拉里只是常见值，右边可以填任意 model id —— 中转站的模型名经常和官方对不上。
              {dirtyModel ? (
                <span style={{ color: 'var(--state-warning-fg)' }}> 未保存：回车或点开别处生效。</span>
              ) : (
                <>
                  {' '}
                  当前生效：<code>{profile.modelId || '未选'}</code>
                </>
              )}
            </div>
          </div>

          <div className="field" style={{ marginBottom: profile.builtIn ? 0 : 14 }}>
            <label>API 地址（留空用默认）</label>
            <div className="row">
              <input
                value={baseUrl}
                disabled={busy}
                placeholder={profile.officialOrigin}
                onChange={(e) => setBaseUrl(e.target.value)}
              />
              <button
                disabled={busy || baseUrl === profile.baseUrlOverride}
                onClick={() => void updateProfile({ baseUrlOverride: baseUrl })}
              >
                应用
              </button>
              {profile.baseUrlOverride && (
                <button
                  disabled={busy}
                  onClick={() => {
                    setBaseUrl('');
                    void updateProfile({ baseUrlOverride: '' });
                  }}
                >
                  恢复官方
                </button>
              )}
            </div>
            <div className="help">
              填中转站地址即可走中转。当前生效：<code>{profile.origin}</code>
              {profile.isRelay && (
                <span style={{ color: 'var(--state-warning-fg)' }}>
                  {' '}
                  —— 你的代码上下文会经过这个第三方。
                </span>
              )}
            </div>
          </div>

          {!profile.builtIn && (
            <div className="row">
              <span className="spacer" />
              <ConfirmAction
                label="删除此 Provider…"
                confirmLabel="确认删除 Provider"
                busyLabel="删除中…"
                busy={busy}
                tone="err"
                armKey={profile.providerId}
                consequence={{
                  kind: 'ready',
                  detail: (
                  <>
                    <strong>删除 {profile.label} 会连同下列内容一起消失：</strong>
                    <ul className="preview-list" style={{ fontFamily: 'inherit' }}>
                      <li>这个 provider 的描述符（地址 {profile.origin}、协议 {profile.wire}）</li>
                      <li>保存的模型选择（{profile.modelId || '未选'}）与自定义地址</li>
                      <li>
                        {profile.credentialSource === 'APP'
                          ? `应用内保存的 API Key（${profile.credentialHint}）—— 一并删除，不会在磁盘上留下孤儿密文`
                          : '（没有应用内 API Key 需要删除）'}
                      </li>
                    </ul>
                    <div style={{ marginTop: 4 }}>
                      正在使用它的运行会在下一次模型调用时失败：路由在任务创建时冻结，不会自动换 provider。
                    </div>
                  </>
                  ),
                }}
                onConfirm={async () => {
                  setBusy(true);
                  try {
                    const r = await call('model.removeProvider', {
                      providerId: profile.providerId,
                    });
                    onProfilesChanged(r.profiles);
                  } catch (err) {
                    onError(err);
                  } finally {
                    setBusy(false);
                  }
                }}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
