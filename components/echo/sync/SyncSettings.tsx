"use client";

/**
 * ECHO — Settings: the Account & sync section (B3 wiring, 1.3.0).
 *
 * Renders ONLY when cloud sync is configured (useSyncEngine → null keeps
 * the local-only app completely free of account UI). Surfaces:
 *   - the username + password account surface (create / sign in / convert
 *     anonymous / change password / sign out) with the irreversible-loss
 *     warning and its explicit acknowledgement checkbox;
 *   - honest sync status for every protocol state (never implies synced
 *     data when it has not synced);
 *   - the bootstrap choice (merge / keep-local / replace-local) with the
 *     choice-before-mutation contract;
 *   - the device manager (current-device indication, rename, revoke,
 *     revoked/unavailable states);
 *   - the conflict archive (unresolved/near-full/paused banners, details,
 *     keep-my-version / keep-the-other-version, resolved history).
 *
 * All copy is bilingual (EN/AR) and the layout uses logical CSS properties
 * so RTL mirrors automatically. Keyboard accessible: real buttons, labelled
 * inputs, dialog focus management from the shared UI primitives.
 */

import React from "react";
import {
  CloudOff, Cloud, RefreshCw, Smartphone, ShieldAlert, KeyRound, UserRound,
  MonitorSmartphone, AlertTriangle, CheckCircle2, ChevronDown, ChevronUp,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/echo/i18n";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useSyncEngine } from "./useSyncEngine";
import { getSyncEngine, AuthFlowError, type SyncEngineSnapshot } from "@/lib/echo/sync/engine";
import type { ConflictCard, DeviceViewModel } from "@/lib/echo/sync/deviceManager";

export function SyncSettingsSection() {
  const engine = useSyncEngine();
  if (!engine) return null; // unconfigured → no account/sync surface at all
  return <SyncSettingsBody snapshot={engine} />;
}

function SyncSettingsBody({ snapshot }: { snapshot: SyncEngineSnapshot }) {
  const { t } = useI18n();
  const signedIn = Boolean(snapshot.session);

  return (
    <>
      <AccountCard snapshot={snapshot} />
      {signedIn && <SyncStatusCard snapshot={snapshot} />}
      {signedIn && <DevicesCard snapshot={snapshot} />}
      {signedIn && <ConflictsCard snapshot={snapshot} />}
    </>
  );
}

/* ─────────────────────────── account ─────────────────────────── */

function AccountCard({ snapshot }: { snapshot: SyncEngineSnapshot }) {
  const { t } = useI18n();
  const [mode, setMode] = React.useState<null | "signup" | "signin" | "convert" | "password">(null);
  const session = snapshot.session;

  return (
    <section className="echo-card rounded-xl p-4 md:p-5" aria-label={t("sync.account.title")}>
      <div className="mb-3 flex items-center gap-2.5">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-secondary/70 text-echo-accent">
          <Cloud className="h-4 w-4" aria-hidden />
        </span>
        <div>
          <h2 className="text-sm font-semibold text-foreground">{t("sync.account.title")}</h2>
          <p className="text-xs text-muted-foreground">{t("sync.account.sub")}</p>
        </div>
      </div>

      {!session ? (
        <div className="flex flex-col gap-3">
          <p className="text-xs leading-relaxed text-muted-foreground">{t("sync.account.localOnly")}</p>
          <p className="text-xs leading-relaxed text-muted-foreground">{t("sync.account.signedOut.sub")}</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => setMode("signup")}>{t("sync.account.create")}</Button>
            <Button size="sm" variant="outline" onClick={() => setMode("signin")}>{t("sync.account.signIn")}</Button>
          </div>
        </div>
      ) : session.isAnonymous ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="echo-chip text-echo-gold">{t("sync.account.anonymous.badge")}</span>
            <span className="text-xs text-muted-foreground">{t("sync.account.anonymousSession")}</span>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">{t("sync.account.anonymous.sub")}</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => setMode("convert")}>{t("sync.account.convert")}</Button>
            <SignOutButton />
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="flex flex-wrap items-center gap-2 text-sm text-foreground">
            <UserRound className="h-4 w-4 text-echo-accent" aria-hidden />
            {t("sync.account.signedInAs", { name: session.username ?? "—" })}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => setMode("password")}>
              <KeyRound className="h-3.5 w-3.5" aria-hidden />
              {t("sync.account.changePassword")}
            </Button>
            <SignOutButton />
          </div>
        </div>
      )}

      <AuthDialogs mode={mode} setMode={setMode} snapshot={snapshot} />
    </section>
  );
}

function SignOutButton() {
  const { t } = useI18n();
  const { toast } = useToast();
  const [busy, setBusy] = React.useState(false);
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={busy}
      onClick={() => {
        const engine = getSyncEngine();
        if (!engine) return;
        setBusy(true);
        void engine.signOut().finally(() => {
          setBusy(false);
          toast({ description: t("sync.account.signedOut") });
        });
      }}
    >
      {t("sync.account.signOut")}
    </Button>
  );
}

function AuthDialogs({
  mode, setMode, snapshot,
}: {
  mode: null | "signup" | "signin" | "convert" | "password";
  setMode: (m: null | "signup" | "signin" | "convert" | "password") => void;
  snapshot: SyncEngineSnapshot;
}) {
  const close = () => setMode(null);
  return (
    <>
      <AccountCredentialsDialog
        open={mode === "signup"}
        onClose={close}
        submitKey="sync.auth.create.submit"
        requireAck
      />
      <AccountCredentialsDialog
        open={mode === "signin"}
        onClose={close}
        submitKey="sync.auth.signin.submit"
      />
      <AccountCredentialsDialog
        open={mode === "convert"}
        onClose={close}
        submitKey="sync.account.convert"
        requireAck
        convertAnonymous
      />
      <ChangePasswordDialog open={mode === "password"} onClose={close} snapshot={snapshot} />
    </>
  );
}

function AccountCredentialsDialog({
  open, onClose, submitKey, requireAck = false, convertAnonymous = false,
}: {
  open: boolean;
  onClose: () => void;
  submitKey: string;
  requireAck?: boolean;
  convertAnonymous?: boolean;
}) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [ack, setAck] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setUsername(""); setPassword(""); setConfirm(""); setAck(false); setError(null);
    }
  }, [open]);

  const mismatch = confirm.length > 0 && confirm !== password;

  const submit = async () => {
    const engine = getSyncEngine();
    if (!engine) return;
    if (password !== confirm) {
      setError(t("sync.auth.error.weak_password"));
      return;
    }
    if (requireAck && !ack) return;
    setBusy(true);
    setError(null);
    try {
      if (convertAnonymous) {
        await engine.convertAnonymousToAccount(username.trim(), password);
      } else if (submitKey === "sync.auth.create.submit") {
        await engine.signUp(username.trim(), password);
      } else {
        await engine.signIn(username.trim(), password);
      }
      onClose();
    } catch (e) {
      const code = e instanceof AuthFlowError ? e.code : "unknown";
      setError(t(`sync.auth.error.${code}`));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="echo-card max-w-md">
        <DialogHeader>
          <DialogTitle>{t(submitKey)}</DialogTitle>
          <DialogDescription className="text-left">{t("sync.account.signedOut.sub")}</DialogDescription>
        </DialogHeader>

        {requireAck && (
          <div role="alert" className="rounded-xl border border-echo-gold/50 bg-echo-gold/10 p-3">
            <p className="flex items-center gap-2 text-sm font-semibold text-echo-gold">
              <ShieldAlert className="h-4 w-4 shrink-0" aria-hidden />
              {t("sync.warning.title")}
            </p>
            <p className="mt-1.5 text-xs leading-relaxed text-foreground/90">{t("sync.warning.body")}</p>
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{t("sync.warning.passwordManager")}</p>
          </div>
        )}

        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy && (!requireAck || ack)) void submit();
          }}
        >
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-foreground">{t("sync.auth.username")}</span>
            <Input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              required
              minLength={3}
              maxLength={32}
              dir="ltr"
            />
            <span className="text-[11px] text-muted-foreground">{t("sync.auth.username.hint")}</span>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-foreground">{t("sync.auth.password")}</span>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={requireAck ? "new-password" : "current-password"}
              required
              minLength={requireAck ? 8 : 1}
              maxLength={128}
              dir="ltr"
            />
          </label>
          {requireAck && (
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-foreground">{t("sync.auth.confirm")}</span>
              <Input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
                required
                maxLength={128}
                dir="ltr"
                aria-invalid={mismatch}
              />
              {mismatch && (
                <span role="alert" className="text-[11px] text-destructive">
                  {t("sync.auth.error.weak_password")}
                </span>
              )}
            </label>
          )}
          {requireAck && (
            <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-border p-3">
              <Switch checked={ack} onCheckedChange={setAck} aria-label={t("sync.warning.ack")} />
              <span className="text-[11px] leading-relaxed text-foreground/90">{t("sync.warning.ack")}</span>
            </label>
          )}
          {error && (
            <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              {t("app.cancel")}
            </Button>
            <Button type="submit" disabled={busy || (requireAck && !ack)}>
              {busy ? t("sync.status.syncing") : t(submitKey)}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ChangePasswordDialog({
  open, onClose,
}: {
  open: boolean;
  onClose: () => void;
  snapshot: SyncEngineSnapshot;
}) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [current, setCurrent] = React.useState("");
  const [next, setNext] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setCurrent(""); setNext(""); setConfirm(""); setError(null);
    }
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="echo-card max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("sync.account.changePassword")}</DialogTitle>
          <DialogDescription className="text-left">{t("sync.warning.title")}</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            const engine = getSyncEngine();
            if (!engine) return;
            if (next !== confirm) {
              setError(t("sync.auth.error.weak_password"));
              return;
            }
            setBusy(true);
            setError(null);
            try {
              await engine.changePassword(current, next);
              onClose();
              toast({ description: t("sync.pw.done") });
            } catch (err) {
              const code = err instanceof AuthFlowError ? err.code : "unknown";
              setError(t(`sync.auth.error.${code}`));
            } finally {
              setBusy(false);
            }
          }}
        >
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-foreground">{t("sync.pw.current")}</span>
            <Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} required maxLength={128} dir="ltr" autoComplete="current-password" />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-foreground">{t("sync.pw.new")}</span>
            <Input type="password" value={next} onChange={(e) => setNext(e.target.value)} required minLength={8} maxLength={128} dir="ltr" autoComplete="new-password" />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-foreground">{t("sync.auth.confirm")}</span>
            <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required maxLength={128} dir="ltr" autoComplete="new-password" />
          </label>
          {error && (
            <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>{t("app.cancel")}</Button>
            <Button type="submit" disabled={busy}>{t("sync.pw.submit")}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ─────────────────────────── status ─────────────────────────── */

function SyncStatusCard({ snapshot }: { snapshot: SyncEngineSnapshot }) {
  const { t, lang } = useI18n();
  const needsBootstrap =
    snapshot.uiState === "must_rebootstrap" ||
    (snapshot.session && snapshot.deviceId && !snapshot.bootstrapped && snapshot.bootstrapPhase === null);
  const stateColor: Record<string, string> = {
    synced: "border-echo-pine/40 bg-echo-pine/10 text-echo-pine",
    syncing: "border-echo-accent/40 bg-echo-accent/10 text-echo-accent",
    degraded: "border-echo-gold/40 bg-echo-gold/10 text-echo-gold",
    paused_conflicts: "border-destructive/40 bg-destructive/10 text-destructive",
    must_rebootstrap: "border-echo-gold/40 bg-echo-gold/10 text-echo-gold",
  };
  const fmt = (ts: number | null) =>
    ts ? new Date(ts).toLocaleString(lang === "ar" ? "ar-EG" : "en-GB", { dateStyle: "medium", timeStyle: "short" }) : null;

  return (
    <section className="echo-card rounded-xl p-4 md:p-5" aria-label={t("sync.status.title")}>
      <div className="mb-3 flex items-center gap-2.5">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-secondary/70 text-echo-accent">
          {snapshot.uiState === "synced" ? <CheckCircle2 className="h-4 w-4" aria-hidden /> : <CloudOff className="h-4 w-4" aria-hidden />}
        </span>
        <h2 className="text-sm font-semibold text-foreground">{t("sync.status.title")}</h2>
        <span
          role="status"
          className={cn(
            "ms-auto rounded-full border px-2.5 py-1 text-[11px] font-semibold",
            stateColor[snapshot.uiState] ?? "border-border bg-secondary/60 text-muted-foreground",
          )}
        >
          {t(`sync.status.${snapshot.uiState}`)}
        </span>
      </div>

      <p className="text-xs leading-relaxed text-muted-foreground">{t(`sync.status.${snapshot.uiState}`)}</p>

      {snapshot.outboxCount > 0 && (
        <p className="mt-2 text-[11px] text-muted-foreground">{t("sync.action.pending", { n: snapshot.outboxCount })}</p>
      )}
      {snapshot.lastSyncedAt && (
        <p className="mt-1 text-[11px] text-muted-foreground">{t("sync.devices.lastSynced", { when: fmt(snapshot.lastSyncedAt) ?? "—" })}</p>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        {needsBootstrap ? (
          <BootstrapChoiceCard snapshot={snapshot} />
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={snapshot.busy || !snapshot.deviceId}
            onClick={() => {
              const engine = getSyncEngine();
              void engine?.syncNow();
            }}
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden />
            {t("sync.action.syncNow")}
          </Button>
        )}
      </div>

      {snapshot.bootstrapPhase && snapshot.bootstrapPhase !== "done" && snapshot.bootstrapPhase !== "choice_pending" && (
        <p role="status" className="mt-3 rounded-lg border border-echo-accent/40 bg-echo-accent/10 px-3 py-2 text-xs text-foreground/90">
          {t("sync.bootstrap.busy", { phase: snapshot.bootstrapPhase })}
        </p>
      )}
    </section>
  );
}

function BootstrapChoiceCard({ snapshot }: { snapshot: SyncEngineSnapshot }) {
  const { t } = useI18n();
  const [busyKind, setBusyKind] = React.useState<string | null>(null);

  const choose = (kind: "merge" | "keep_local" | "replace_local") => {
    const engine = getSyncEngine();
    if (!engine) return;
    setBusyKind(kind);
    void engine.chooseBootstrap(kind).finally(() => setBusyKind(null));
  };

  const options: Array<{ kind: "merge" | "keep_local" | "replace_local"; label: string; sub: string }> = [
    { kind: "merge", label: t("sync.bootstrap.merge"), sub: t("sync.bootstrap.merge.sub") },
    { kind: "keep_local", label: t("sync.bootstrap.keep_local"), sub: t("sync.bootstrap.keep_local.sub") },
    { kind: "replace_local", label: t("sync.bootstrap.replace_local"), sub: t("sync.bootstrap.replace_local.sub") },
  ];

  return (
    <div className="w-full rounded-xl border border-echo-gold/50 bg-echo-gold/5 p-3.5">
      <p className="text-sm font-semibold text-foreground">{t("sync.bootstrap.title")}</p>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t("sync.bootstrap.sub")}</p>
      <div className="mt-3 flex flex-col gap-2" role="radiogroup" aria-label={t("sync.bootstrap.title")}>
        {options.map((o) => (
          <button
            key={o.kind}
            role="radio"
            aria-checked={busyKind === o.kind}
            disabled={busyKind !== null}
            onClick={() => choose(o.kind)}
            className={cn(
              "flex min-h-[44px] flex-col items-start gap-1 rounded-xl border p-3 text-start transition",
              busyKind === o.kind
                ? "border-echo-accent/60 bg-echo-accent/10"
                : "border-border hover:border-echo-accent/40 hover:bg-secondary/50",
            )}
          >
            <span className="text-sm font-medium text-foreground">{o.label}</span>
            <span className="text-[11px] leading-relaxed text-muted-foreground">{o.sub}</span>
          </button>
        ))}
      </div>
      {busyKind && (
        <p role="status" className="mt-2 text-[11px] text-echo-accent">{t("sync.status.syncing")}</p>
      )}
      {/* snapshot is intentionally referenced for future progress display */}
      <span className="hidden">{snapshot.bootstrapPhase}</span>
    </div>
  );
}

/* ─────────────────────────── devices ─────────────────────────── */

function DevicesCard({ snapshot }: { snapshot: SyncEngineSnapshot }) {
  const { t, lang } = useI18n();
  const [renaming, setRenaming] = React.useState<DeviceViewModel | null>(null);
  const [revoking, setRevoking] = React.useState<DeviceViewModel | null>(null);
  const [renameValue, setRenameValue] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const fmt = (iso: string | null) =>
    iso ? new Date(iso).toLocaleString(lang === "ar" ? "ar-EG" : "en-GB", { dateStyle: "medium", timeStyle: "short" }) : null;

  const stateChip = (d: DeviceViewModel) => {
    const styles: Record<DeviceViewModel["stateKey"], string> = {
      this_device: "border-echo-accent/50 bg-echo-accent/10 text-echo-accent",
      active: "border-echo-pine/40 bg-echo-pine/10 text-echo-pine",
      inactive: "border-border bg-secondary/60 text-muted-foreground",
      revoked: "border-destructive/40 bg-destructive/10 text-destructive line-through",
    };
    return (
      <span className={cn("rounded-full border px-2 py-0.5 text-[10px] font-semibold", styles[d.stateKey])}>
        {t(`sync.devices.${d.stateKey}`)}
      </span>
    );
  };

  return (
    <section className="echo-card rounded-xl p-4 md:p-5" aria-label={t("sync.devices.title")}>
      <div className="mb-3 flex items-center gap-2.5">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-secondary/70 text-echo-accent">
          <MonitorSmartphone className="h-4 w-4" aria-hidden />
        </span>
        <div>
          <h2 className="text-sm font-semibold text-foreground">{t("sync.devices.title")}</h2>
          <p className="text-xs text-muted-foreground">{t("sync.devices.sub")}</p>
        </div>
      </div>

      {snapshot.devices.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("sync.devices.empty")}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {snapshot.devices.map((d) => (
            <li
              key={d.id}
              className={cn(
                "flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border p-3",
                d.revoked ? "border-destructive/25 bg-destructive/5 opacity-80" : "border-border",
              )}
            >
              <Smartphone className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-foreground" dir="auto">{d.name}</span>
                <span className="block text-[11px] text-muted-foreground">
                  {d.lastSyncedAt
                    ? t("sync.devices.lastSynced", { when: fmt(d.lastSyncedAt) ?? "—" })
                    : t("sync.devices.never")}
                </span>
              </span>
              {stateChip(d)}
              {!d.revoked && (
                <span className="flex items-center gap-1.5">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setRenaming(d);
                      setRenameValue(d.name);
                    }}
                  >
                    {t("sync.devices.rename")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => setRevoking(d)}
                  >
                    {t("sync.devices.revoke")}
                  </Button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* rename dialog */}
      <Dialog open={Boolean(renaming)} onOpenChange={(v) => !v && setRenaming(null)}>
        <DialogContent className="echo-card max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("sync.devices.rename.title")}</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const engine = getSyncEngine();
              if (!engine || !renaming) return;
              setBusy(true);
              const ok = await engine.renameDevice(renaming.id, renameValue.trim());
              setBusy(false);
              if (ok) setRenaming(null);
            }}
          >
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-foreground">{t("sync.devices.rename.title")}</span>
              <Input
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                required
                minLength={1}
                maxLength={60}
                dir="auto"
              />
            </label>
            <DialogFooter className="mt-3">
              <Button type="button" variant="outline" onClick={() => setRenaming(null)} disabled={busy}>
                {t("app.cancel")}
              </Button>
              <Button type="submit" disabled={busy || renameValue.trim().length === 0}>
                {t("sync.devices.rename.submit")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* revoke confirm */}
      <AlertDialog open={Boolean(revoking)} onOpenChange={(v) => !v && setRevoking(null)}>
        <AlertDialogContent className="echo-card">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("sync.devices.revoke.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {revoking?.isCurrent
                ? `${t("sync.devices.current.confirm")} ${t("sync.devices.revoke.body")}`
                : t("sync.devices.revoke.body")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{t("app.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/85"
              disabled={busy}
              onClick={async () => {
                const engine = getSyncEngine();
                if (!engine || !revoking) return;
                setBusy(true);
                await engine.revokeDevice(revoking.id);
                setBusy(false);
                setRevoking(null);
              }}
            >
              {t("sync.devices.revoke")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

/* ─────────────────────────── conflicts ─────────────────────────── */

function ConflictsCard({ snapshot }: { snapshot: SyncEngineSnapshot }) {
  const { t, lang } = useI18n();
  const [open, setOpen] = React.useState<number | null>(null);
  const [busy, setBusy] = React.useState<number | null>(null);
  const unresolved = snapshot.conflicts.filter((c) => c.resolvedAt === null);
  const resolved = snapshot.conflicts.filter((c) => c.resolvedAt !== null);
  const fmt = (iso: string) =>
    new Date(iso).toLocaleString(lang === "ar" ? "ar-EG" : "en-GB", { dateStyle: "medium", timeStyle: "short" });

  const banner = () => {
    if (!snapshot.archive) return null;
    const { state, unresolved: n, cap } = snapshot.archive;
    if (state === "full") return { cls: "border-destructive/40 bg-destructive/10 text-destructive", text: t("sync.conflicts.paused", { n, cap }) };
    if (state === "near_full") return { cls: "border-echo-gold/40 bg-echo-gold/10 text-echo-gold", text: t("sync.conflicts.near_full", { n, cap }) };
    return null;
  };
  const b = banner();

  return (
    <section className="echo-card rounded-xl p-4 md:p-5" aria-label={t("sync.conflicts.title")}>
      <div className="mb-3 flex items-center gap-2.5">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-secondary/70 text-echo-accent">
          <AlertTriangle className="h-4 w-4" aria-hidden />
        </span>
        <div>
          <h2 className="text-sm font-semibold text-foreground">{t("sync.conflicts.title")}</h2>
          <p className="text-xs text-muted-foreground">{t("sync.conflicts.sub")}</p>
        </div>
        {unresolved.length > 0 && (
          <span className="ms-auto rounded-full border border-echo-gold/40 bg-echo-gold/10 px-2.5 py-1 text-[11px] font-semibold text-echo-gold">
            {t("sync.conflicts.unresolved", { n: unresolved.length })}
          </span>
        )}
      </div>

      {b && (
        <p role="alert" className={cn("mb-3 rounded-xl border px-3 py-2 text-xs leading-relaxed", b.cls)}>
          {b.text}
        </p>
      )}

      {snapshot.conflicts.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("sync.conflicts.empty")}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {[...unresolved, ...resolved].map((c) => (
            <ConflictRow
              key={c.conflictId}
              c={c}
              expanded={open === c.conflictId}
              onToggle={() => setOpen(open === c.conflictId ? null : c.conflictId)}
              busy={busy === c.conflictId}
              fmt={fmt}
              onResolve={async (action) => {
                const engine = getSyncEngine();
                if (!engine) return;
                setBusy(c.conflictId);
                await engine.resolveConflict(c.conflictId, action);
                setBusy(null);
              }}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function ConflictRow({
  c, expanded, onToggle, busy, fmt, onResolve,
}: {
  c: ConflictCard;
  expanded: boolean;
  onToggle: () => void;
  busy: boolean;
  fmt: (iso: string) => string;
  onResolve: (action: "restore" | "discard") => Promise<void>;
}) {
  const { t } = useI18n();
  const Chevron = expanded ? ChevronUp : ChevronDown;
  return (
    <li
      className={cn(
        "rounded-xl border p-3",
        c.resolvedAt ? "border-border bg-secondary/30 opacity-80" : "border-echo-gold/30 bg-echo-gold/5",
      )}
    >
      <button
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 text-start"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground">
            {t(`sync.conflicts.entity.${c.entity}`)} · <span dir="auto">{c.recordId}</span>
          </span>
          <span className="block text-[11px] text-muted-foreground">
            {t(`sync.conflicts.reason.${c.reason}`)} · {t("sync.conflicts.created", { when: fmt(c.createdAt) })}
          </span>
        </span>
        {c.resolvedAt ? (
          <span className="echo-chip text-muted-foreground">{t("sync.conflicts.resolvedAt")}</span>
        ) : null}
        <Chevron className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      </button>
      {expanded && c.resolvedAt === null && (
        <div className="mt-2.5 flex flex-wrap gap-2 border-t border-border/60 pt-2.5">
          <Button size="sm" disabled={busy} onClick={() => void onResolve("restore")}>
            {t("sync.conflicts.restore")}
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void onResolve("discard")}>
            {t("sync.conflicts.discard")}
          </Button>
        </div>
      )}
      {expanded && c.resolvedAt !== null && (
        <p className="mt-2 border-t border-border/60 pt-2 text-[11px] text-muted-foreground">
          {t("sync.conflicts.resolvedAt")} · {fmt(c.resolvedAt)}
        </p>
      )}
    </li>
  );
}
