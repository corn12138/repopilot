const FALLBACK = 'http://localhost:9999';

export function apiBaseUrl(env) {
  // 读的是错误的约定：客户端拿不到 process.env，注入的 env 被无视
  return process.env.API_URL ?? FALLBACK;
}
