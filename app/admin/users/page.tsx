import Link from "next/link";
import { getUserAccessOverview } from "@/lib/admin/users";
import { principalHasRole, requirePermission } from "@/lib/authorization";
import { UserManagementPanel } from "../user-management-panel";

export default async function AdminUsersPage() {
  const principal = await requirePermission("role:assignment:manage");
  const isAdmin = await principalHasRole(principal.id, "admin");

  if (!isAdmin) {
    return (
      <main className="admin-shell">
        <section className="admin-header">
          <div>
            <p className="eyebrow">Admin console</p>
            <h1>User access</h1>
            <p className="lead">
              User access management is restricted to Administrator role members.
            </p>
          </div>
        </section>
      </main>
    );
  }

  const userAccessOverview = await getUserAccessOverview();

  return (
    <main className="admin-shell">
      <section className="admin-header">
        <div>
          <p className="eyebrow">Admin console</p>
          <h1>User access</h1>
          <p className="lead">
            Signed in as <span className="code">{principal.email}</span>.{" "}
            <Link className="table-link" href="/admin">
              Admin dashboard
            </Link>
          </p>
        </div>
      </section>

      <UserManagementPanel initialOverview={userAccessOverview} />
    </main>
  );
}
