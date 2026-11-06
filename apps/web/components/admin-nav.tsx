import Link from "next/link";

const TABS = [
  { href: "", label: "Overview" },
  { href: "/challenges", label: "Challenges" },
  { href: "/settings", label: "Settings" },
] as const;

export function AdminNav({ restaurantId, name, slug, current }: { restaurantId: string; name: string; slug: string; current: "" | "/challenges" | "/settings" }) {
  return (
    <header className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">{name}</h1>
        <nav className="flex gap-4 text-sm">
          <Link className="underline" href={`/r/${slug}`}>Customer page</Link>
          <Link className="underline" href={`/staff/${restaurantId}`}>Staff mode</Link>
        </nav>
      </div>
      <nav className="flex gap-1 border-b border-neutral-200" aria-label="Dashboard sections">
        {TABS.map((t) => (
          <Link
            key={t.href}
            href={`/admin/${restaurantId}${t.href}`}
            aria-current={current === t.href ? "page" : undefined}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${current === t.href ? "border-neutral-900" : "border-transparent text-neutral-500 hover:text-neutral-900"}`}
          >
            {t.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}
