"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const tabs = [
  { href: "/", label: "Chat" },
  { href: "/skills", label: "Skills" },
  { href: "/agents", label: "Agents" },
];

export default function NavBar() {
  const path = usePathname();
  return (
    <nav className="h-11 flex items-center px-4 border-b border-border bg-surface text-sm">
      <div className="font-semibold mr-6 tracking-tight">agent-kit-web</div>
      <div className="flex items-center gap-0.5">
        {tabs.map((t) => {
          const active = path === t.href || (t.href !== "/" && path.startsWith(t.href));
          return (
            <Link
              key={t.href}
              href={t.href}
              className={`px-3 py-1.5 rounded-md transition ${
                active
                  ? "bg-elevated text-text"
                  : "text-muted hover:text-text hover:bg-elevated/60"
              }`}
            >
              {t.label}
            </Link>
          );
        })}
      </div>
      <div className="ml-auto text-xs text-subtle">Opus 4.7 · agent-kit</div>
    </nav>
  );
}
