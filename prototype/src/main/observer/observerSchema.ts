import { z } from 'zod';

/**
 * 观察通道的请求校验。放在 main 而不是 shared：Preload 要打包 shared 拿通道常量，
 * zod 不该被拖进 Preload 包。信封形状 = { method, payload }，严格模式 ——
 * 多余字段直接拒，未知方法直接拒。
 */
const empty = z.object({}).strict();

export const observerEnvelopeSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('observer.status'), payload: empty }).strict(),
  z.object({ method: z.literal('observer.enable'), payload: empty }).strict(),
  z.object({ method: z.literal('observer.disable'), payload: empty }).strict(),
  z.object({ method: z.literal('observer.listSessions'), payload: empty }).strict(),
  z
    .object({
      method: z.literal('observer.watch'),
      payload: z.object({ sessionId: z.string().min(1).max(300) }).strict(),
    })
    .strict(),
  z
    .object({
      method: z.literal('observer.unwatch'),
      payload: z.object({ sessionId: z.string().min(1).max(300).optional() }).strict(),
    })
    .strict(),
  z
    .object({
      method: z.literal('observer.prepareHandoff'),
      payload: z.object({ sessionId: z.string().min(1).max(300) }).strict(),
    })
    .strict(),
]);

export type ObserverEnvelope = z.infer<typeof observerEnvelopeSchema>;
