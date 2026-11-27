"use client";

/**
 * ECHO — built-in status page (A2/§5.4: the minimal FREE status-page approach).
 *
 * A $0, dependency-free status surface served by the app itself: it renders
 * /api/health for humans, bilingually (EN/AR, RTL-aware). No third-party
 * script, no paid status host. External uptime probing is deliberately the
 * owner's later choice (human checkpoint) — this page + /api/health are what
 * any probe would watch.
 */

import React from "react";
import { I18nProvider, useI18n } from "@/lib/echo/i18n";
import type { Language } from "@/lib/echo/types";

interface HealthProvider {
  id: string;
  name: string;
  enabled: boolean;
  userToggleable: boolean;
  cloudSyncPolicy: string;
}

interface HealthPayload {
  status: string;
  version: string;
  uptimeSeconds: number;
  integrations: Record<string, boolean>;
  providers: HealthProvider[];
}

function StatusBody() {
  const { t, lang } = useI18n();
  const [health, setHealth] = React.useState<HealthPayload | null>(null);
  const [error, setError] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    fetch("/api/health")
      .then((r) => r.json())
      .then((data: HealthPayload) => {
        if (!cancelled) setHealth(data);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main
      dir={lang === "ar" ? "rtl" : "ltr"}
      className="min-h-dvh bg-background px-4 py-10 text-foreground md:px-8"
    >
      <div className="mx-auto max-w-2xl">
        <h1 className="echo-display text-2xl font-semibold">{t("status.title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("status.sub")}</p>

        <div className="mt-6 rounded-xl border border-border bg-card p-4">
          {error && (
            <p className="text-sm text-destructive">{t("status.fetchError")}</p>
          )}
          {!error && !health && (
            <p className="text-sm text-muted-foreground">{t("status.loading")}</p>
          )}
          {health && (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <span
                  className={`inline-flex h-2.5 w-2.5 rounded-full ${
                    health.status === "ok" ? "bg-emerald-500" : "bg-destructive"
                  }`}
                  aria-hidden
                />
                <span className="text-sm font-medium">
                  {health.status === "ok" ? t("status.ok") : t("status.down")}
                </span>
                <span className="text-xs text-muted-foreground">
                  {t("status.version", { version: health.version })} ·{" "}
                  {t("status.uptime", { seconds: health.uptimeSeconds })}
                </span>
              </div>

              <h2 className="mt-5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t("status.integrations")}
              </h2>
              <ul className="mt-2 grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                {Object.entries(health.integrations).map(([key, on]) => (
                  <li
                    key={key}
                    className="flex items-center gap-2 rounded-lg border border-border px-2.5 py-1.5 text-xs"
                  >
                    <span
                      className={`inline-block h-1.5 w-1.5 rounded-full ${on ? "bg-emerald-500" : "bg-muted-foreground/40"}`}
                      aria-hidden
                    />
                    <span className="font-mono">{key}</span>
                  </li>
                ))}
              </ul>

              <h2 className="mt-5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t("status.providers")}
              </h2>
              <ul className="mt-2 flex flex-col gap-1">
                {health.providers.map((p) => (
                  <li
                    key={p.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-2.5 py-1.5 text-xs"
                  >
                    <span className="flex items-center gap-2">
                      <span
                        className={`inline-block h-1.5 w-1.5 rounded-full ${p.enabled ? "bg-emerald-500" : "bg-muted-foreground/40"}`}
                        aria-hidden
                      />
                      {p.name}
                    </span>
                    {p.cloudSyncPolicy === "none" && (
                      <span className="rounded border border-echo-gold/40 px-1.5 py-0.5 text-[10px] text-echo-gold">
                        {t("status.localOnly")}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>

        <p className="mt-4 text-[11px] leading-relaxed text-muted-foreground/80">
          {t("status.probeNote")}
        </p>
      </div>
    </main>
  );
}

/** Wrap with the app's own i18n provider. The main app persists language in
 *  IndexedDB (the zustand settings store); this standalone page keeps it
 *  simple and follows the BROWSER language instead — Arabic users get an
 *  Arabic, RTL status page without touching the app's stores. */
export default function StatusPage() {
  const [lang, setLang] = React.useState<Language>("en");
  React.useEffect(() => {
    if (typeof navigator !== "undefined" && navigator.language?.startsWith("ar")) {
      setLang("ar");
    }
  }, []);
  return (
    <I18nProvider lang={lang} onLangChange={setLang}>
      <StatusBody />
    </I18nProvider>
  );
}
