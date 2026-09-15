import Link from "next/link";

export default function NotFound() {
  return (
    <section className="panel state">
      <h2>Not found</h2>
      <p className="muted">This page or lead does not exist in the selected company.</p>
      <Link className="button" href="/">
        Back to overview
      </Link>
    </section>
  );
}
