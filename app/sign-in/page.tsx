import Link from "next/link";
import { SignInForm } from "./sign-in-form";

export default function SignInPage() {
  return (
    <main>
      <section className="hero">
        <div>
          <p className="eyebrow">Authorized access</p>
          <h1>Sign in for committee and operational access</h1>
          <p className="lead">
            Secure access is limited to ZCG committee members, relevant FPF staff, and a small number of other
            specifically authorized collaborators. It supports administration and deeper research for the
            committee&apos;s decision process.
          </p>
          <p>
            No account is required to use key public areas, including the <Link className="table-link" href="/dashboard">grant dashboard</Link>,
            grant details, <Link className="table-link" href="/admin/knowledge">evidence-summary search</Link>, and
            published Committee Briefings.
          </p>
          <p>
            Authorized users can enter an email address to receive a secure sign-in link and a one-time code. Their
            account opens only the areas they have permission to use.
          </p>
        </div>
        <aside className="panel">
          <h2>Get a sign-in email</h2>
          <SignInForm />
        </aside>
      </section>
    </main>
  );
}
