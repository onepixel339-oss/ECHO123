/**
 * GET  /api/sync/devices  — list own devices (view read, RLS-scoped)
 * POST /api/sync/devices  — register a device {name, platform, appVersion}
 * PATCH /api/sync/devices  — rename {deviceId, name}
 * DELETE /api/sync/devices?deviceId= — revoke (advisory-first, idempotent)
 */
import { z } from "zod";
import { callerFromRequest, handleRouteError } from "@/lib/echo/server/sync";

const registerSchema = z.object({
  name: z.string().max(60).optional(),
  platform: z.enum(["windows", "macos", "linux", "android", "ios", "other"]).optional(),
  appVersion: z.string().max(40).optional(),
});
const renameSchema = z.object({
  deviceId: z.string().uuid(),
  name: z.string().min(1).max(60),
});

export async function GET(request: Request): Promise<Response> {
  try {
    const caller = callerFromRequest(request);
    const result = await caller.rpc<{ devices?: unknown[] }>("sync_device_list", {});
    if (result && typeof result === "object" && "devices" in (result as object)) {
      return Response.json(result);
    }
    return Response.json({ devices: result });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const parsed = registerSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return Response.json({ error: "bad_request" }, { status: 400 });
    const caller = callerFromRequest(request);
    const id = await caller.rpc<string>("sync_device_register", {
      p_name: parsed.data.name ?? null,
      p_platform: parsed.data.platform ?? null,
      p_app_version: parsed.data.appVersion ?? null,
    });
    return Response.json({ ok: true, deviceId: id });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function PATCH(request: Request): Promise<Response> {
  try {
    const parsed = renameSchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: "bad_request" }, { status: 400 });
    const caller = callerFromRequest(request);
    const result = await caller.rpc("sync_device_rename", {
      p_device_id: parsed.data.deviceId,
      p_name: parsed.data.name,
    });
    return Response.json(result);
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const deviceId = url.searchParams.get("deviceId") ?? "";
    if (!z.string().uuid().safeParse(deviceId).success) {
      return Response.json({ error: "bad_request" }, { status: 400 });
    }
    const caller = callerFromRequest(request);
    const result = await caller.rpc("sync_device_revoke", { p_device_id: deviceId });
    return Response.json(result);
  } catch (err) {
    return handleRouteError(err);
  }
}
