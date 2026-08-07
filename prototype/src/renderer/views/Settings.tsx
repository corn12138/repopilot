import { useState } from 'react';
import type { DoctorCheck, ModelConnectionProfile } from '@shared/domain';
import { call } from '../bridge';
import { Badge, Banner, Card, DoctorBadge } from '../components/common';

export function SettingsView({
  checks,
  profiles,
  secureStorage,
  onProfilesChanged,
  onRefresh,
  onError,
}: {
  checks: DoctorCheck[];
  profiles: ModelConnectionProfile[];
  secureStorage: boolean;
  onProfilesChanged: (profiles: ModelConnectionProfile[]) => void;
  onRefresh: () => Promise<void>;
  onError: (err: unknown) => void;
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
                <span style={{ color: 'var(--warn)', fontSize: 11 }}>{c.remediation}</span>
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
    </>
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
        <div style={{ color: 'var(--text-faint)', fontSize: 11.5, padding: '2px 4px 6px' }}>{empty}</div>
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
      <button style={{ marginTop: 12, color: 'var(--accent)' }} onClick={() => setOpen(true)}>
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
      <div className="provider-head" onClick={() => setOpen((v) => !v)}>
        <span className="tree-caret">{open ? '▾' : '▸'}</span>
        {sourceBadge}
        <strong style={{ fontSize: 12.5, minWidth: 110 }}>{profile.label}</strong>
        <code style={{ fontSize: 11, color: 'var(--text-dim)' }}>{profile.modelId || '未选模型'}</code>
        <Badge>{profile.wire}</Badge>
        {profile.kind === 'CUSTOM' && <Badge tone="purple">自定义</Badge>}
        {profile.isRelay && <Badge tone="warn">经第三方</Badge>}
        {profile.credentialHint && (
          <span style={{ fontSize: 10.5, color: 'var(--text-faint)', fontFamily: 'var(--mono)' }}>
            {profile.credentialHint}
          </span>
        )}
        <span className="spacer" />
        <button
          disabled={!profile.enabled || busy}
          onClick={(e) => {
            e.stopPropagation();
            void test();
          }}
        >
          {busy ? '…' : '测试连接'}
        </button>
      </div>

      {result && (
        <div
          style={{
            fontSize: 11.5,
            fontFamily: 'var(--mono)',
            padding: '4px 12px 6px 30px',
            color: result.ok ? 'var(--ok)' : 'var(--err)',
            wordBreak: 'break-word',
          }}
        >
          {result.text}
        </div>
      )}

      {open && (
        <div className="provider-body">
          <div className="field">
            <label>
              API Key
              {profile.credentialSource === 'ENV' && (
                <span style={{ color: 'var(--text-faint)' }}>
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
                <button className="danger" disabled={busy} onClick={() => void saveKey('')}>
                  删除
                </button>
              )}
            </div>
            <div className="help">
              {profile.docUrl ? (
                <>
                  去 <span style={{ color: 'var(--accent)' }}>{safeHost(profile.docUrl)}</span> 获取。
                </>
              ) : null}
              保存后立即生效，不用重启。
            </div>
          </div>

          <div className="field">
            <label>模型</label>
            <div className="row">
              <select
                value={profile.availableModels.includes(profile.modelId) ? profile.modelId : '__custom'}
                disabled={busy}
                onChange={(e) => {
                  if (e.target.value !== '__custom') void updateProfile({ modelId: e.target.value });
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
                style={{ flex: 1 }}
                defaultValue={profile.modelId}
                disabled={busy}
                placeholder="或直接填写精确 model id"
                onBlur={(e) => {
                  if (e.target.value.trim() && e.target.value.trim() !== profile.modelId) {
                    void updateProfile({ modelId: e.target.value });
                  }
                }}
              />
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
                <span style={{ color: 'var(--warn)' }}>
                  {' '}
                  —— 你的代码上下文会经过这个第三方。
                </span>
              )}
            </div>
          </div>

          {!profile.builtIn && (
            <div className="row">
              <span className="spacer" />
              <button
                className="danger"
                disabled={busy}
                onClick={async () => {
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
              >
                删除此 Provider
              </button>
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
