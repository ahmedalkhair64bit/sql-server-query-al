import { signUp } from "@/lib/actions";
import { signupOpen, SIGNUP_CLOSED } from "@/lib/auth";
import { AuthForm } from "@/components/auth-form";

export const dynamic = "force-dynamic";

export default function Signup() {
  if (!signupOpen())
    return (
      <>
        <h1 className="auth-title">Sign-up is closed</h1>
        <p className="auth-note">{SIGNUP_CLOSED}</p>
        <p>
          <a href="/login">Sign in instead</a>
        </p>
      </>
    );
  return (
    <>
      <h1 className="auth-title">Create account</h1>
      <AuthForm
        action={signUp}
        submit="Create account"
        fields={[
          {
            name: "email",
            label: "Email",
            type: "email",
            autoComplete: "email",
          },
          {
            name: "password",
            label: "Password",
            type: "password",
            autoComplete: "new-password",
            help: "10 characters minimum.",
          },
        ]}
      />
      <p>
        <a href="/login">Sign in instead</a>
      </p>
    </>
  );
}
