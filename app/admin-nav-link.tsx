import Link from "next/link";
import { getCurrentPrincipal, principalHasPermission } from "@/lib/authorization";

export async function AdminNavLink() {
  const principal = await getCurrentPrincipal();

  if (!principal || !(await principalHasPermission(principal.id, "role:assignment:manage"))) {
    return null;
  }

  return <Link href="/admin">Admin</Link>;
}
