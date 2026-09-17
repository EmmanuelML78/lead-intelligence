export default function Loading() {
  return (
    <div className="skeleton" aria-busy="true" aria-live="polite">
      <span />
      <span />
      <span />
      <p className="muted">Loading operational view…</p>
    </div>
  );
}
