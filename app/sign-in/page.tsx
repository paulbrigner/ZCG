import { SignInForm } from "./sign-in-form";

export default function SignInPage() {
  return (
    <main>
      <section className="hero">
        <div>
          <p className="eyebrow">Secure access</p>
          <h1>Sign in to the dashboard</h1>
          <p className="lead">
            Enter your email address to receive a secure sign-in link and a one-time
            code. Your account will open the areas you have permission to use.
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
