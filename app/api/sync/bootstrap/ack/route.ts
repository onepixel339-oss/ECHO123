/**
 * POST /api/sync/bootstrap/ack {deviceId, snapshotId, drainedSeq} — the
 * PATCH1 O-1 resolution: the ack RECEIVES and validates the requesting
 * device before any device-scoped write.
 */
import { z } from "zod";
import { callerFromRequest, handleRouteError } from "@/lib/echo/server/sync";

const bodySchema = z.object({
  deviceId: z.string().uuid(),
  snapshotId: z.number().int().min(1),
  drainedSeq: z.number().int().min(0),
});

export async function POST(request: Request): Promise<Response> {
  try {
    const parsed = bodySchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: "bad_request" }, { status: 400 });
    const { deviceId, snapshotId, drainedSeq } = parsed.data;
    const caller = callerFromRequest(request);
    const result = await caller.rpc("sync_bootstrap_ack", {
      p_device_id: deviceId,
      p_snapshot_id: snapshotId,
      p_drained_seq: drainedSeq,
    });
    return Response.json(result);
  } catch (err) {
    return handleRouteError(err);
  }
}
