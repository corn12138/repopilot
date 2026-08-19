/** 一次异步读取的实体归属与本地请求身份。 */
export interface RequestIdentity<OwnerId> {
  readonly ownerId: OwnerId;
  readonly requestId: number;
}

/**
 * Renderer 读取状态的共同形状。
 *
 * `ownerId` 防止把 A 实体的结果画到 B 上，`requestId` 则区分同一实体的连续刷新。
 * 二者都必须匹配，较早请求才没有资格覆盖较新的界面事实。
 */
export type OwnedAsyncState<OwnerId, Data, Failure> =
  | { readonly status: 'idle'; readonly ownerId: null; readonly requestId: null }
  | ({ readonly status: 'loading' } & RequestIdentity<OwnerId>)
  | ({ readonly status: 'ready'; readonly data: Data } & RequestIdentity<OwnerId>)
  | ({ readonly status: 'error'; readonly error: Failure } & RequestIdentity<OwnerId>);

export const OWNED_ASYNC_IDLE = {
  status: 'idle',
  ownerId: null,
  requestId: null,
} as const satisfies OwnedAsyncState<never, never, never>;

export interface LatestRequestGuard<OwnerId> {
  begin(ownerId: OwnerId): RequestIdentity<OwnerId>;
  isLatest(identity: RequestIdentity<OwnerId>): boolean;
  latest(): RequestIdentity<OwnerId> | null;
  invalidate(): void;
}

/**
 * 创建一个面板私有的 latest-request-wins 闸门。
 *
 * 这是纯内存身份工具：它不取消 I/O，也不解释错误，只让调用方在提交结果前证明
 * “这仍是当前实体的最新请求”。失效后旧 Promise 可以自然结束，但不能再改变状态。
 */
export function createLatestRequestGuard<OwnerId>(): LatestRequestGuard<OwnerId> {
  let sequence = 0;
  let current: RequestIdentity<OwnerId> | null = null;

  return {
    begin(ownerId) {
      sequence += 1;
      current = { ownerId, requestId: sequence };
      return current;
    },
    isLatest(identity) {
      return current?.requestId === identity.requestId && current.ownerId === identity.ownerId;
    },
    latest() {
      return current;
    },
    invalidate() {
      current = null;
    },
  };
}

export function isOwnedReady<OwnerId, Data, Failure>(
  state: OwnedAsyncState<OwnerId, Data, Failure>,
  ownerId: OwnerId,
): state is { readonly status: 'ready'; readonly data: Data } & RequestIdentity<OwnerId> {
  return state.status === 'ready' && state.ownerId === ownerId;
}
