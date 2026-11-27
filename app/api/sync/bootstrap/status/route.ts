/** GET /api/sync/bootstrap/status — boundary report (auto-creates snapshot). */
import { callerFromRequest, handleRouteError } from "@/lib/echo/server/sync";

export async function GET(request: Request): Promise<Response> {
  try {
    const caller = callerFromRequest(request);
    const result = await caller.rpc("sync_bootstrap_status", {});
    return Response.json(result);
  } catch (err) {
    return handleRouteError(err);
  }
}
