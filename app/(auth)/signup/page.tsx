import { signUp } from "@/lib/actions";
import { AuthForm } from "@/components/auth-form";
export default function Signup() {
  return <>
    <h1 style={{ fontFamily: "var(--qai-font-display)", fontSize: "var(--qai-text-2xl)" }}>Create account</h1>
    <AuthForm action={signUp} submit="Create account" fields={[
      { name: "email", label: "Email", type: "email", autoComplete: "email" },
      { name: "password", label: "Password", type: "password", autoComplete: "new-password",
        help: "10 characters minimum." }]} />
    <p><a href="/login">Sign in instead</a></p>
  </>;
}
