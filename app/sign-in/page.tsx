import { SignInForm } from "./sign-in-form";

export default function SignInPage() {
  return (
    <main>
      <section className="hero">
        <div>
          <p className="eyebrow">Authentication</p>
          <h1>Sign in to the dashboard</h1>
          <p className="lead">
            Phase 0 uses Better Auth email codes with bootstrap admin assignment
            controlled by deployment configuration.
          </p>
        </div>
        <aside className="panel">
          <h2>Email code</h2>
          <SignInForm />
        </aside>
      </section>
    </main>
  );
}
