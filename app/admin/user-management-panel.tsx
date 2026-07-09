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
  if (role.source === "email") {
    return `${role.roleName} (email grant)`;
  }

  if (role.source === "domain") {
    return `${role.roleName} (domain grant)`;
  }

  return role.roleName;
}

const userAccessHelp =
  "Signed-in users are principals created by Better Auth login activity. Pending email grants apply to one email address; domain grants apply to every matching address when that person signs in.";

export function UserManagementPanel({ initialOverview }: UserManagementPanelProps) {
  const [overview, setOverview] = useState(initialOverview);
  const [email, setEmail] = useState("");
  const [emailRoleKey, setEmailRoleKey] = useState("admin");
  const [emailReason, setEmailReason] = useState("Dashboard utility grant");
  const [domain, setDomain] = useState("zcashcommunitygrants.org");
  const [domainRoleKey, setDomainRoleKey] = useState("committee");
  const [domainReason, setDomainReason] = useState("ZCG domain access");
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
        roleKey: emailRoleKey,
        reason: emailReason
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

  async function submitDomainGrant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setMessage("");
    setError("");

    try {
      const result = await postUserAccess({
        action: "grant_domain_role",
        domain,
        roleKey: domainRoleKey,
        reason: domainReason
      });
      setOverview(result.overview);
      setMessage("Domain role grant saved.");
    } catch (grantError) {
      setError(grantError instanceof Error ? grantError.message : "Failed to grant domain role.");
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

  async function revokeDomainRole(domainName: string, role: UserRoleGrant) {
    const confirmed = window.confirm(`Remove ${role.roleName} from every ${domainName} email address?`);

    if (!confirmed) {
      return;
    }

    setPending(true);
    setMessage("");
    setError("");

    try {
      const result = await postUserAccess({
        action: "revoke_domain_role",
        domain: domainName,
        roleKey: role.roleKey
      });
      setOverview(result.overview);
      setMessage("Domain role grant removed.");
    } catch (revokeError) {
      setError(revokeError instanceof Error ? revokeError.message : "Failed to revoke domain role.");
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
            {overview.users.length} signed-in users | {overview.pendingEmailGrants.length} pending email grants |{" "}
            {overview.emailDomainGrants.length} domain grants
            <MetricHelp align="left" body={userAccessHelp} label="User access counts" />
          </span>
        </div>
      </div>

      <div className="access-grant-forms">
        <form className="table-controls user-access-form" onSubmit={submitGrant}>
          <h3>Exact email grant</h3>
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
            <select onChange={(event) => setEmailRoleKey(event.target.value)} value={emailRoleKey}>
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
              onChange={(event) => setEmailReason(event.target.value)}
              placeholder="Why this access is being granted"
              type="text"
              value={emailReason}
            />
          </label>
          <button disabled={pending} type="submit">
            Grant email role
          </button>
        </form>

        <form className="table-controls user-access-form" onSubmit={submitDomainGrant}>
          <h3>Domain grant</h3>
          <label className="search-field">
            <span>Domain</span>
            <input
              autoComplete="off"
              inputMode="url"
              onChange={(event) => setDomain(event.target.value)}
              placeholder="example.org"
              required
              type="text"
              value={domain}
            />
          </label>
          <label className="search-field compact-field">
            <span>Role</span>
            <select onChange={(event) => setDomainRoleKey(event.target.value)} value={domainRoleKey}>
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
              onChange={(event) => setDomainReason(event.target.value)}
              placeholder="Why this domain is being granted"
              type="text"
              value={domainReason}
            />
          </label>
          <button disabled={pending} type="submit">
            Grant domain role
          </button>
        </form>
      </div>

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

      {overview.emailDomainGrants.length ? (
        <div className="pending-grants">
          <h3>Email domain grants</h3>
          <div className="status-list">
            {overview.emailDomainGrants.map((grant) => (
              <p className="status-item" key={grant.domain}>
                <span>@{grant.domain}</span>
                <span className="role-list">
                  {grant.roles.map((role) => (
                    <span className="role-chip" key={`${grant.domain}-${role.roleKey}`}>
                      {roleLabel(role)}
                      <button
                        className="inline-danger"
                        disabled={pending}
                        onClick={() => revokeDomainRole(grant.domain, role)}
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
