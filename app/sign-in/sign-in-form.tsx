"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

type Step = "email" | "code";

async function postAuth<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`/api/auth${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    credentials: "same-origin",
    body: JSON.stringify(body)
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const message =
      payload?.message ??
      payload?.error?.message ??
      payload?.error ??
      "Authentication request failed.";
    throw new Error(String(message));
  }

  return payload as T;
}

export function SignInForm() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function requestCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    setStatus("");

    try {
      await postAuth<{ success: boolean }>("/sign-in-options", {
        email
      });
      setStep("code");
      setStatus("Sign-in email sent. Use the secure link or enter the code below.");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to send code.");
    } finally {
      setPending(false);
    }
  }

  async function verifyCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    setStatus("");

    try {
      await postAuth<{ token: string }>("/sign-in/email-otp", {
        email,
        otp,
        name: email
      });
      setStatus("Signed in.");
      router.push("/dashboard");
      router.refresh();
    } catch (verifyError) {
      setError(verifyError instanceof Error ? verifyError.message : "Unable to verify code.");
    } finally {
      setPending(false);
    }
  }

  if (step === "code") {
    return (
      <form className="auth-form" onSubmit={verifyCode}>
        <label className="field">
          <span>Email</span>
          <input
            autoComplete="email"
            inputMode="email"
            onChange={(event) => setEmail(event.target.value)}
            required
            type="email"
            value={email}
          />
        </label>
        <label className="field">
          <span>Code</span>
          <input
            autoComplete="one-time-code"
            inputMode="numeric"
            maxLength={12}
            onChange={(event) => setOtp(event.target.value)}
            required
            type="text"
            value={otp}
          />
        </label>
        {status ? <p className="form-status">{status}</p> : null}
        {error ? <p className="form-error">{error}</p> : null}
        <div className="form-actions">
          <button disabled={pending} type="submit">
            {pending ? "Verifying..." : "Sign in"}
          </button>
          <button disabled={pending} onClick={() => setStep("email")} type="button" className="ghost-button">
            Use another email
          </button>
        </div>
      </form>
    );
  }

  return (
    <form className="auth-form" onSubmit={requestCode}>
      <label className="field">
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
      {status ? <p className="form-status">{status}</p> : null}
      {error ? <p className="form-error">{error}</p> : null}
      <div className="form-actions">
          <button disabled={pending} type="submit">
            {pending ? "Sending..." : "Send sign-in email"}
        </button>
      </div>
    </form>
  );
}
