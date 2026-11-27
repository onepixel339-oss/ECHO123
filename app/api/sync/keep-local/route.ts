/** POST /api/sync/keep-local {intentId} — epoch reset (typed confirm UI first). */
import { z } from "zod";
import { callerFromRequest, handleRouteError } from "@/lib/echo/server/sync";

const bodySchema = z.object({ intentId: z.string().min(1).max(120) });

export async function POST(request: Request): Promise<Response> {
  try {
    const parsed = bodySchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: "bad_request" }, { status: 400 });
    const caller = callerFromRequest(request);
    const result = await caller.rpc("sync_keep_local", { p_intent_id: parsed.data.intentId });
    return Response.json(result);
  } catch (err) {
    return handleRouteError(err);
  }
}
