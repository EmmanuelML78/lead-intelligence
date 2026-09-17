"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Resumen", short: "Inicio" },
  { href: "/leads", label: "Cola de leads", short: "Cola" },
  { href: "/capacity", label: "Capacidad", short: "Capacidad" },
  { href: "/data-quality", label: "Calidad de datos", short: "Calidad" }
] as const;

export function DashboardNav({
  variant = "sidebar"
}: {
  variant?: "sidebar" | "top" | "bottom";
}) {
  const pathname = usePathname();
  const className = variant === "sidebar" ? "nav" : variant === "top" ? "nav-top" : "nav-bottom";

  return (
    <nav className={className} aria-label="Navegación">
      {LINKS.map((link) => {
        const current =
          link.href === "/"
            ? pathname === "/"
            : pathname === link.href || pathname.startsWith(`${link.href}/`);
        return (
          <Link key={link.href} href={link.href} aria-current={current ? "page" : undefined}>
            {variant === "bottom" ? link.short : link.label}
          </Link>
        );
      })}
    </nav>
  );
}
