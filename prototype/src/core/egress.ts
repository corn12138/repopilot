import type {
  DataEgressDisclosure,
  EgressDataClass,
  EgressDestination,
  ModelConnectionProfile,
  ModelRouteResolution,
} from '@shared/domain';
import { digestOf } from '@shared/ids';
import type { ExternalConnectorProfile } from './external/connector';

/**
 * 数据出站披露（PRD-DATA-001 的原型子集，"对等可见"原则的入口那一半）。
 *
 * 用户在 task.create 之前看到这一份：要把哪些类别的数据、送到谁那里（官方还是中转、
 * 精确 origin 与模型）、经哪条通道（RepoPilot 的 ModelGateway 还是本机外部 CLI 自己出站）、
 * 以及我们**不知道**对方的保留/训练/地域政策。digest 覆盖全部字段；task.create 必须带回
 * 同一个 digest，Core 重算比对 —— 路由一变 digest 就变，旧同意自动失效。
 *
 * 纯函数：输入全部是已解析的事实（profile / 冻结路由 / 连接器 / 快照统计），不读全局状态，
 * 所以 Renderer 侧展示的那份与 Core 侧校验的那份只可能因为输入不同而不同。
 */

export interface DisclosureInput {
  readonly snapshotId: string;
  readonly snapshotFileCount: number;
  readonly implementer: { profile: ModelConnectionProfile; resolution: ModelRouteResolution };
  readonly reviewer:
    | { kind: 'MODEL_API'; profile: ModelConnectionProfile; resolution: ModelRouteResolution }
    | { kind: 'EXTERNAL_CLI'; connector: ExternalConnectorProfile }
    | null;
  readonly author: { connector: ExternalConnectorProfile } | null;
}

const IMPLEMENTER_CLASSES: readonly EgressDataClass[] = [
  'TASK_TEXT',
  'REPOSITORY_SNAPSHOT_EXCERPTS',
  'COMMAND_OUTPUT',
  'REVIEW_FINDINGS',
];
const REVIEWER_CLASSES: readonly EgressDataClass[] = ['TASK_TEXT', 'PATCH_DIFF', 'COMMAND_OUTPUT'];
const AUTHOR_CLI_CLASSES: readonly EgressDataClass[] = [
  'TASK_TEXT',
  'REPOSITORY_FULL_COPY_VIA_CLI',
  'COMMAND_OUTPUT',
  'REVIEW_FINDINGS',
];

export function buildDisclosure(input: DisclosureInput): DataEgressDisclosure {
  const destinations: EgressDestination[] = [];
  const impl = input.implementer;
  destinations.push({
    role: 'IMPLEMENTER',
    channel: 'MODEL_API',
    label: `${impl.profile.label} · ${impl.resolution.modelId}`,
    providerId: impl.resolution.providerId,
    origin: impl.resolution.origin,
    isRelay: impl.profile.isRelay || impl.profile.kind === 'RELAY',
    modelId: impl.resolution.modelId,
    resolutionDigest: impl.resolution.digest,
    // 外部作者在场时，实现方模型只做规划（与整改简报无关），但仍可能看到命令输出/审核发现
    dataClasses: input.author ? ['TASK_TEXT', 'REPOSITORY_SNAPSHOT_EXCERPTS', 'COMMAND_OUTPUT'] : IMPLEMENTER_CLASSES,
  });
  if (input.reviewer) {
    if (input.reviewer.kind === 'MODEL_API') {
      const r = input.reviewer;
      destinations.push({
        role: 'REVIEWER',
        channel: 'MODEL_API',
        label: `${r.profile.label} · ${r.resolution.modelId}`,
        providerId: r.resolution.providerId,
        origin: r.resolution.origin,
        isRelay: r.profile.isRelay || r.profile.kind === 'RELAY',
        modelId: r.resolution.modelId,
        resolutionDigest: r.resolution.digest,
        dataClasses: REVIEWER_CLASSES,
      });
    } else {
      const c = input.reviewer.connector;
      destinations.push({
        role: 'REVIEWER',
        channel: 'EXTERNAL_CLI',
        label: `${c.label}${c.version ? ` · ${c.version}` : ''}（本机 CLI）`,
        providerId: c.vendor.toLowerCase(),
        origin: null,
        isRelay: false,
        modelId: null,
        // 本机 CLI 没有网络 route，但有身份：路径 + 版本。见下方 consentedResolutionDigests
        resolutionDigest: c.identityDigest,
        dataClasses: REVIEWER_CLASSES,
      });
    }
  }
  if (input.author) {
    const c = input.author.connector;
    destinations.push({
      role: 'AUTHOR',
      channel: 'EXTERNAL_CLI',
      label: `${c.label}${c.version ? ` · ${c.version}` : ''}（本机 CLI）`,
      providerId: c.vendor.toLowerCase(),
      origin: null,
      isRelay: false,
      modelId: null,
      resolutionDigest: c.identityDigest,
      dataClasses: AUTHOR_CLI_CLASSES,
    });
  }
  const body = {
    disclosureVersion: 1 as const,
    snapshotId: input.snapshotId,
    snapshotFileCount: input.snapshotFileCount,
    destinations,
    policy: { retention: 'UNKNOWN' as const, training: 'UNKNOWN' as const, region: 'UNKNOWN' as const },
  };
  return { ...body, digest: digestOf(body) };
}

/**
 * 同意所覆盖的**目的地身份**集合。
 *
 * MODEL_API 目的地给的是冻结路由 digest（profileId+providerId+origin+modelId）；
 * EXTERNAL_CLI 目的地给的是连接器 identityDigest（binaryPath+version）。
 *
 * 外部 CLI 此前在这里贡献为 0（`resolutionDigest` 硬编码 null），后果有两层：
 * 用户同意的那份披露对外部选手**没有任何运行期约束力**；而且从 task.create 到真正
 * spawn 之间，用户把 Codex 升了一版、或 PATH 指向了另一个二进制，平台也发现不了 ——
 * 这正是 ModelGateway 那边 `ROUTE_DRIFT` 要挡的东西，只是外部这条路上一直没装。
 */
export function consentedResolutionDigests(d: DataEgressDisclosure): string[] {
  return d.destinations.map((x) => x.resolutionDigest).filter((x): x is string => x !== null);
}
