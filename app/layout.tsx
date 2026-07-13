import type { Metadata } from "next";
import Link from "next/link";
import { AdminNavLink } from "./admin-nav-link";
import { SessionNav } from "./session-nav";
import "./globals.css";

export const metadata: Metadata = {
  title: "ZCG Grants Prototype",
  description: "Phase 0 prototype for the Zcash Community Grants operating system."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <div className="topbar-inner">
            <Link className="brand" href="/">
              ZCG Grants Prototype
            </Link>
            <nav className="nav" aria-label="Primary">
              <a href="/dashboard">Dashboard</a>
              <a href="/admin/knowledge">Knowledge</a>
              <AdminNavLink />
              <SessionNav />
            </nav>
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
