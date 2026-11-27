/** GET /api/sync/status — epoch/head/watermark/hashes/archiveState. */
import { callerFromRequest, handleRouteError } from "@/lib/echo/server/sync";

export async function GET(request: Request): Promise<Response> {
  try {
    const caller = callerFromRequest(request);
    const result = await caller.rpc("sync_status", {});
    return Response.json(result);
  } catch (err) {
    return handleRouteError(err);
  }
}
