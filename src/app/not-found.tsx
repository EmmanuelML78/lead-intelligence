import Link from "next/link";

export default function NotFound() {
  return (
    <section className="panel state">
      <h2>No encontrado</h2>
      <p className="muted">Esta página o lead no existe en la empresa seleccionada.</p>
      <Link className="button" href="/">
        Volver al resumen
      </Link>
    </section>
  );
}
