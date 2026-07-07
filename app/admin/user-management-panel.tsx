"use client";

import { FormEvent, useState } from "react";
import type { UserAccessOverview, UserRoleGrant } from "@/lib/admin/users";
import { MetricHelp } from "./metric-help";

type UserManagementPanelProps = {
  initialOverview: UserAccessOverview;
};

async function postUserAccess(body: Record<string, unknown>) {
  const response = await fetch("/api/admin/users", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(String(payload?.error ?? "Failed to update user access."));
  }

  return payload as { overview: UserAccessOverview };
}

function roleLabel(role: UserRoleGrant) {
  return role.source === "email" ? `${role.roleName} (email grant)` : role.roleName;
}

const userAccessHelp =
  "Signed-in users are principals created by Better Auth login activity. Pending email grants are role grants assigned to email addresses before that person signs in.";

export function UserManagementPanel({ initialOverview }: UserManagementPanelProps) {
  const [overview, setOverview] = useState(initialOverview);
  const [email, setEmail] = useState("");
  const [roleKey, setRoleKey] = useState("admin");
  const [reason, setReason] = useState("Admin utility grant");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function submitGrant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setMessage("");
    setError("");

    try {
      const result = await postUserAccess({
        action: "grant_role",
        email,
        roleKey,
        reason
      });
      setOverview(result.overview);
      setEmail("");
      setMessage("Role grant saved.");
    } catch (grantError) {
      setError(grantError instanceof Error ? grantError.message : "Failed to grant role.");
    } finally {
      setPending(false);
    }
  }

  async function revokeRole(emailAddress: string, role: UserRoleGrant) {
    const confirmed = window.confirm(`Remove ${role.roleName} from ${emailAddress}?`);

    if (!confirmed) {
      return;
    }

    setPending(true);
    setMessage("");
    setError("");

    try {
      const result = await postUserAccess({
        action: "revoke_role",
        email: emailAddress,
        roleKey: role.roleKey
      });
      setOverview(result.overview);
      setMessage("Role grant removed.");
    } catch (revokeError) {
      setError(revokeError instanceof Error ? revokeError.message : "Failed to revoke role.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="panel user-management" aria-label="User access management">
      <div className="section-heading">
        <div>
          <h2>User access</h2>
          <span className="section-count">
            {overview.users.length} signed-in users | {overview.pendingEmailGrants.length} pending email grants
            <MetricHelp align="left" body={userAccessHelp} label="User access counts" />
          </span>
        </div>
      </div>

      <form className="table-controls user-access-form" onSubmit={submitGrant}>
        <label className="search-field">
          <span>Email</span>
          <input
            autoComplete="email"
            inputMode="email"
            onChange={(event) => setEmail(event.target.value)}
            placeholder="name@example.org"
            required
            type="email"
            value={email}
          />
        </label>
        <label className="search-field compact-field">
          <span>Role</span>
          <select onChange={(event) => setRoleKey(event.target.value)} value={roleKey}>
            {overview.roles.map((role) => (
              <option key={role.roleKey} value={role.roleKey}>
                {role.name}
              </option>
            ))}
          </select>
        </label>
        <label className="search-field">
          <span>Reason</span>
          <input
            onChange={(event) => setReason(event.target.value)}
            placeholder="Why this access is being granted"
            type="text"
            value={reason}
          />
        </label>
        <button disabled={pending} type="submit">
          Grant role
        </button>
      </form>

      {message ? <p className="form-status">{message}</p> : null}
      {error ? <p className="form-error">{error}</p> : null}

      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>User</th>
              <th>Provider</th>
              <th>Roles</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {overview.users.length ? (
              overview.users.map((user) => (
                <tr key={user.principalId}>
                  <td>
                    <strong>{user.email}</strong>
                    <span className="subtle">{user.displayName ?? "No display name"}</span>
                  </td>
                  <td>{user.authProvider}</td>
                  <td>
                    <div className="role-list">
                      {user.roles.length ? (
                        user.roles.map((role) => (
                          <span className="role-chip" key={`${user.principalId}-${role.roleKey}-${role.source}`}>
                            {roleLabel(role)}
                            <button
                              className="inline-danger"
                              disabled={pending}
                              onClick={() => revokeRole(user.email, role)}
                              type="button"
                            >
                              Remove
                            </button>
                          </span>
                        ))
                      ) : (
                        <span className="subtle">No roles</span>
                      )}
                    </div>
                  </td>
                  <td>{new Date(user.updatedAt).toLocaleString()}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={4}>No signed-in users yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {overview.pendingEmailGrants.length ? (
        <div className="pending-grants">
          <h3>Pending email grants</h3>
          <div className="status-list">
            {overview.pendingEmailGrants.map((grant) => (
              <p className="status-item" key={grant.email}>
                <span>{grant.email}</span>
                <span className="role-list">
                  {grant.roles.map((role) => (
                    <span className="role-chip" key={`${grant.email}-${role.roleKey}`}>
                      {roleLabel(role)}
                      <button
                        className="inline-danger"
                        disabled={pending}
                        onClick={() => revokeRole(grant.email, role)}
                        type="button"
                      >
                        Remove
                      </button>
                    </span>
                  ))}
                </span>
              </p>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
