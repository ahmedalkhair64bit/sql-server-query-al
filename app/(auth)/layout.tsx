import Image from "next/image";
export default function Auth({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        maxWidth: 420,
        margin: "0 auto",
        padding: "var(--qai-space-3xl) var(--qai-space-l)",
      }}
    >
      <Image
        src="/brand/logo.png"
        alt="SQL Server Query AI"
        width={200}
        height={200}
        style={{ display: "block", margin: "0 auto 12px" }}
      />
      {children}
      <p className="colophon">
        ShowPlan XML in · Jev-ranked remediation out · self-hosted
      </p>
    </div>
  );
}
