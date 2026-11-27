/** POST /api/sync/restore-backup {backupId} — reversible restore (new epoch). */
import { z } from "zod";
import { callerFromRequest, handleRouteError } from "@/lib/echo/server/sync";

const bodySchema = z.object({ backupId: z.number().int().min(1) });

export async function POST(request: Request): Promise<Response> {
  try {
    const parsed = bodySchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: "bad_request" }, { status: 400 });
    const caller = callerFromRequest(request);
    const result = await caller.rpc("sync_restore_backup", { p_backup_id: parsed.data.backupId });
    return Response.json(result);
  } catch (err) {
    return handleRouteError(err);
  }
}
