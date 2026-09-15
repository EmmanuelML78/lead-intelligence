"use client";

export default function DashboardError({
  error,
  reset
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <section className="panel state">
      <h2>Something went wrong</h2>
      <p className="muted">{error.message || "The dashboard could not render this view."}</p>
      <button type="button" onClick={reset}>
        Retry
      </button>
    </section>
  );
}
