"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Overview" },
  { href: "/leads", label: "Lead queue" },
  { href: "/capacity", label: "Capacity" },
  { href: "/data-quality", label: "Data quality" }
] as const;

export function DashboardNav({ variant = "sidebar" }: { variant?: "sidebar" | "mobile" }) {
  const pathname = usePathname();
  return (
    <nav className={variant === "mobile" ? "mobile-nav" : "nav"} aria-label="Dashboard">
      {LINKS.map((link) => {
        const current =
          link.href === "/"
            ? pathname === "/"
            : pathname === link.href || pathname.startsWith(`${link.href}/`);
        return (
          <Link key={link.href} href={link.href} aria-current={current ? "page" : undefined}>
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
