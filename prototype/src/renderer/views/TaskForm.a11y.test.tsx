// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type {
  ModelConnectionProfile,
  ProjectRef,
  RepositoryHarnessProfile,
  RepositorySnapshot,
} from '@shared/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Composer } from './TaskForm';

vi.mock('../bridge', () => ({ call: vi.fn() }));

const project: ProjectRef = {
  projectId: 'project-1',
  name: 'demo',
  displayPath: '~/code/demo',
  createdAt: '2026-08-13T00:00:00.000Z',
};

const snapshot: RepositorySnapshot = {
  snapshotId: 'snapshot-1',
  projectId: 'project-1',
  baseSha: '0123456789abcdef0123456789abcdef01234567',
  branch: 'main',
  baseKind: 'CLEAN_COMMIT',
  dirtyFileCount: 0,
  untrackedCount: 0,
  subPath: '',
  fileCount: 12,
  totalBytes: 4096,
  treeDigest: 'sha256:tree',
  excludedPaths: [],
  createdAt: '2026-08-13T00:00:00.000Z',
};

const profile: RepositoryHarnessProfile = {
  profileId: 'profile-1',
  snapshotId: 'snapshot-1',
  adapterId: 'vite-react-ts',
  adapterVersion: '1.0.0',
  supportStatus: 'VERIFIED',
  detectedSignals: ['vite.config.ts'],
  packageManager: 'pnpm',
  commands: {
    build: {
      commandId: 'build',
      label: '构建',
      argv: ['pnpm', 'build'],
      cwdRelative: '',
      timeoutMs: 60_000,
      risk: 'R1',
      source: 'DETECTED',
    },
    typecheck: {
      commandId: 'typecheck',
      label: '类型检查',
      argv: ['pnpm', 'typecheck'],
      cwdRelative: '',
      timeoutMs: 60_000,
      risk: 'R1',
      source: 'DETECTED',
    },
  },
  protectedPaths: [],
  supportedTaskClasses: ['BUILD_FIX'],
  notes: [],
};

const model: ModelConnectionProfile = {
  profileId: 'model-1',
  providerId: 'anthropic',
  label: 'Claude',
  kind: 'OFFICIAL',
  builtIn: true,
  wire: 'anthropic',
  origin: 'https://api.anthropic.com/v1',
  officialOrigin: 'https://api.anthropic.com/v1',
  baseUrlOverride: '',
  isRelay: false,
  modelId: 'claude-x',
  availableModels: ['claude-x'],
  credentialEnvVar: 'ANTHROPIC_API_KEY',
  credentialEnvVars: ['ANTHROPIC_API_KEY'],
  credentialSource: 'APP',
  fallbackSource: 'NONE',
  fallbackEnvVar: null,
  credentialHint: '…abcd',
  docUrl: 'https://example.invalid',
  enabled: true,
  routeSwitchPolicy: 'MANUAL_ONLY',
  automaticFallback: 'DENY',
};

function composer() {
  return (
    <Composer
      project={project}
      snapshot={snapshot}
      profile={profile}
      modelProfiles={[model]}
      activeRun={null}
      onCreated={vi.fn()}
      onReimport={vi.fn()}
      onOpenRun={vi.fn()}
      onOpenSettings={vi.fn()}
      onError={vi.fn()}
    />
  );
}

function openDialog() {
  const trigger = screen.getByRole('button', { name: /任务选项/ });
  trigger.focus();
  fireEvent.click(trigger);
  return trigger;
}

describe('任务选项弹层的键盘与焦点行为', () => {
  afterEach(() => {
    cleanup();
  });

  it('打开后焦点进入弹层，并声明为 modal', () => {
    render(composer());
    openDialog();

    const dialog = screen.getByRole('dialog', { name: '任务选项' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('Escape 关闭弹层，并把焦点还给触发它的按钮', () => {
    render(composer());
    const trigger = openDialog();
    expect(screen.getByRole('dialog', { name: '任务选项' })).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: '任务选项' })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('Tab 在弹层内循环，不会跑到背后的表单上', () => {
    render(composer());
    openDialog();
    const dialog = screen.getByRole('dialog', { name: '任务选项' });
    const focusables = [
      ...dialog.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ];
    expect(focusables.length).toBeGreaterThan(1);
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;

    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(first);

    first.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('验证命令 chip 通过 aria-pressed 播报开关状态，而不是只靠颜色', () => {
    render(composer());
    // 默认选中 build；typecheck 未选。
    const build = screen.getByRole('button', { name: 'build' });
    const typecheck = screen.getByRole('button', { name: 'typecheck' });
    expect(build.getAttribute('aria-pressed')).toBe('true');
    expect(typecheck.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(typecheck);
    expect(screen.getByRole('button', { name: 'typecheck' }).getAttribute('aria-pressed')).toBe(
      'true',
    );

    fireEvent.click(screen.getByRole('button', { name: 'build' }));
    expect(screen.getByRole('button', { name: 'build' }).getAttribute('aria-pressed')).toBe(
      'false',
    );
  });
});
