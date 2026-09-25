import Image from "next/image";

export default function Auth({ children }: { children: React.ReactNode }) {
  return (
    <div className="auth">
      <a className="auth-brand" href="/login">
        <span className="logo-mark">
          <Image src="/brand/logo.png" alt="" width={74} height={74} />
        </span>
        SQL Server Query AI
      </a>
      {children}
      <p className="colophon">
        ShowPlan XML in · Jev-ranked remediation out · self-hosted
      </p>
    </div>
  );
}
