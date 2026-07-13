"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

type AuthSessionResponse = {
  user?: {
    email?: string | null;
  } | null;
} | null;

async function fetchCurrentSession() {
  const response = await fetch("/api/auth/get-session", {
    credentials: "same-origin",
    headers: {
      accept: "application/json"
    }
  });

  if (!response.ok) {
    return null;
  }

  return (await response.json().catch(() => null)) as AuthSessionResponse;
}

export function SessionNav() {
  const router = useRouter();
  const [email, setEmail] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let active = true;

    fetchCurrentSession()
      .then((session) => {
        if (!active) {
          return;
        }

        setEmail(session?.user?.email ?? null);
      })
      .finally(() => {
        if (active) {
          setLoaded(true);
        }
      });

    return () => {
      active = false;
    };
  }, []);

  async function signOut() {
    setPending(true);

    try {
      await fetch("/api/auth/sign-out", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          "content-type": "application/json"
        },
        body: JSON.stringify({})
      });
    } finally {
      setEmail(null);
      setPending(false);
      router.replace("/sign-in");
      router.refresh();
    }
  }

  if (!loaded) {
    return null;
  }

  if (!email) {
    return <Link href="/sign-in">Sign in</Link>;
  }

  return (
    <span className="session-nav">
      <Link href="/admin/telemetry">Telemetry</Link>
      <Link href="/admin/reconciliations">Reconciliations</Link>
      <span className="session-email">{email}</span>
      <button className="nav-button" disabled={pending} onClick={signOut} type="button">
        {pending ? "Signing out..." : "Sign out"}
      </button>
    </span>
  );
}
