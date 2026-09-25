import { signIn } from "@/lib/actions";
import { signupOpen } from "@/lib/auth";
import { AuthForm } from "@/components/auth-form";

export const dynamic = "force-dynamic";

export default function Login() {
  return (
    <>
      <h1 className="auth-title">Sign in</h1>
      <AuthForm
        action={signIn}
        submit="Sign in"
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
            autoComplete: "current-password",
          },
        ]}
      />
      {signupOpen() && (
        <p>
          <a href="/signup">Create an account</a>
        </p>
      )}
    </>
  );
}
