import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { settingsView } from "@/lib/settings";
import { listAnalyses } from "@/lib/db";
import { Workspace } from "@/components/workspace";
export default async function Console({
  children,
}: {
  children: React.ReactNode;
}) {
  const u = await requireUser();
  const v = settingsView(u.id);
  if (!v.has_analyst || !v.has_jev) redirect("/setup?step=2");
  return <Workspace rows={listAnalyses(u.id)}>{children}</Workspace>;
}
