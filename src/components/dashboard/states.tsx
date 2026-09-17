import type { ReactNode } from "react";

export function EmptyState({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="panel state">
      <h2>{title}</h2>
      <p>{children}</p>
    </section>
  );
}

export function ErrorState({ message }: { message: string }) {
  return (
    <section className="panel state">
      <h2>Panel no disponible</h2>
      <p className="muted">{message}</p>
    </section>
  );
}
