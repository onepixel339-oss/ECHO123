/**
 * POST /api/sync/push — the batched write path (v1.1 §9.3 as amended).
 * zod-validates every op BEFORE any RPC invocation; the push request's
 * `deviceId` is required (a missing/malformed one is rejected 400 before a
 * device row can be touched — PATCH1 §4.3.3 route-validation row).
 */
import { z } from "zod";
import { callerFromRequest, handleRouteError } from "@/lib/echo/server/sync";

const opSchema = z.object({
  opid: z.string().min(1).max(200),
  entity: z.enum(["media_items", "entries", "feedback", "works", "work_links", "user_settings"]),
  recordId: z.string().min(0).max(300),
  op: z.enum(["upsert", "delete"]),
  baseVersion: z.number().int().min(0),
  lamport: z.number().int().optional(),
  record: z.record(z.string(), z.unknown()).optional(),
});

const bodySchema = z.object({
  deviceId: z.string().uuid(),
  epoch: z.number().int().min(1).nullable().optional(),
  schemaVersion: z.literal(4).optional(),
  ops: z.array(opSchema).min(1).max(200),
});

export async function POST(request: Request): Promise<Response> {
  try {
    const parsed = bodySchema.safeParse(await request.json());
    if (!parsed.success) {
      return Response.json({ error: "bad_request", issues: parsed.error.issues.length }, { status: 400 });
    }
    const { deviceId, ops, epoch } = parsed.data;
    const caller = callerFromRequest(request);
    const result = await caller.rpc("sync_push", {
      ops: JSON.parse(JSON.stringify(ops)),
      p_device_id: deviceId,
      p_epoch: epoch ?? null,
    });
    return Response.json(result);
  } catch (err) {
    return handleRouteError(err);
  }
}
