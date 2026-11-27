/** GET /api/sync/bootstrap/page?snapshot=<id>&page=<n> — one immutable page. */
import { z } from "zod";
import { callerFromRequest, handleRouteError } from "@/lib/echo/server/sync";

const querySchema = z.object({
  snapshot: z.coerce.number().int().min(1),
  page: z.coerce.number().int().min(1),
});

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const parsed = querySchema.safeParse({
      snapshot: url.searchParams.get("snapshot"),
      page: url.searchParams.get("page"),
    });
    if (!parsed.success) return Response.json({ error: "bad_request" }, { status: 400 });
    const caller = callerFromRequest(request);
    const result = await caller.rpc("sync_bootstrap_page", {
      p_snapshot_id: parsed.data.snapshot,
      p_page_no: parsed.data.page,
    });
    return Response.json(result);
  } catch (err) {
    return handleRouteError(err);
  }
}
