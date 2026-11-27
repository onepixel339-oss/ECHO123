/**
 * GET /api/sync/pull?since=<cursor>&limit=<n>&deviceId=<uuid> — PATCH1's
 * requesting-device contract: `deviceId` is a required query parameter.
 */
import { z } from "zod";
import { callerFromRequest, handleRouteError } from "@/lib/echo/server/sync";

const querySchema = z.object({
  deviceId: z.string().uuid(),
  since: z.coerce.number().int().min(0),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const parsed = querySchema.safeParse({
      deviceId: url.searchParams.get("deviceId"),
      since: url.searchParams.get("since") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
    });
    if (!parsed.success) {
      return Response.json({ error: "bad_request" }, { status: 400 });
    }
    const { deviceId, since, limit } = parsed.data;
    const caller = callerFromRequest(request);
    const result = await caller.rpc("sync_pull", {
      p_device_id: deviceId,
      p_since: since,
      p_limit: limit ?? 500,
    });
    return Response.json(result);
  } catch (err) {
    return handleRouteError(err);
  }
}
