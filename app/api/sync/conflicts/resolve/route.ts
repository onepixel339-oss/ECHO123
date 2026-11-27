import { z } from "zod";
import { callerFromRequest, handleRouteError } from "@/lib/echo/server/sync";

const bodySchema = z.object({
  conflictId: z.number().int().min(1),
  action: z.enum(["restore", "discard"]),
});

export async function POST(request: Request): Promise<Response> {
  try {
    const parsed = bodySchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: "bad_request" }, { status: 400 });
    const caller = callerFromRequest(request);
    const result = await caller.rpc("sync_conflict_resolve", {
      p_conflict_id: parsed.data.conflictId,
      p_action: parsed.data.action,
    });
    return Response.json(result);
  } catch (err) {
    return handleRouteError(err);
  }
}
