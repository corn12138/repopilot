import { z } from 'zod';

const vendor = z.enum(['CODEX', 'CLAUDE']);
const handle = z.string().min(1).max(100);
const requestId = z.string().min(1).max(100);
const epoch = z.number().int().positive();
const eventSequence = z.number().int().nonnegative();
const projectId = z.string().min(1).max(100).nullable();

export const workbenchEnvelopeSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('workbench.probe'), payload: z.object({ vendor: vendor.optional() }).strict() }).strict(),
  z.object({ method: z.literal('workbench.start'), payload: z.object({ vendor, projectId: z.string().min(1).max(100).optional() }).strict() }).strict(),
  z.object({ method: z.literal('workbench.send'), payload: z.object({ handle, connectionEpoch: epoch, projectId, requestId, text: z.string().min(1).max(20_000) }).strict() }).strict(),
  z.object({ method: z.literal('workbench.interrupt'), payload: z.object({ handle, connectionEpoch: epoch, projectId, requestId }).strict() }).strict(),
  z.object({ method: z.literal('workbench.dispose'), payload: z.object({ handle, connectionEpoch: epoch, projectId }).strict() }).strict(),
  z.object({ method: z.literal('workbench.reconnect'), payload: z.object({ handle, connectionEpoch: epoch, projectId, afterEventSequence: eventSequence }).strict() }).strict(),
  z.object({ method: z.literal('workbench.list'), payload: z.object({ projectId }).strict() }).strict(),
  z.object({ method: z.literal('workbench.summary'), payload: z.object({}).strict() }).strict(),
]);
