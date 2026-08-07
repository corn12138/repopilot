import { createHash, randomUUID } from 'node:crypto';
import type { Digest } from './domain';

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

export function sha256(input: string | Uint8Array): Digest {
  return `sha256:${createHash('sha256').update(input).digest('hex')}`;
}

/** 对象的稳定摘要：键排序后序列化，保证同内容同 digest */
export function digestOf(value: unknown): Digest {
  return sha256(stableStringify(value));
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
