"use client";

import { DASHBOARD_UNAVAILABLE_MESSAGE } from "../lib/dashboard/errors";

export default function DashboardError({
  reset
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <section className="panel state">
      <h2>Algo salió mal</h2>
      <p className="muted">{DASHBOARD_UNAVAILABLE_MESSAGE}</p>
      <button type="button" onClick={reset}>
        Reintentar
      </button>
    </section>
  );
}
