import { signIn } from "@/lib/actions";
import { AuthForm } from "@/components/auth-form";
export default function Login() {
  return <>
    <h1 style={{ fontFamily: "var(--qai-font-display)", fontSize: "var(--qai-text-2xl)" }}>Sign in</h1>
    <AuthForm action={signIn} submit="Sign in" fields={[
      { name: "email", label: "Email", type: "email", autoComplete: "email" },
      { name: "password", label: "Password", type: "password", autoComplete: "current-password" }]} />
    <p><a href="/signup">Create an account</a></p>
  </>;
}
