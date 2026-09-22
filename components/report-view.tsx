"use client";
import { Renderer } from "@openuidev/react-lang";
import { library } from "@/lib/report-ui";

export function ReportView({ oul, streaming }: { oul: string; streaming: boolean }) {
  if (!oul) return null;
  return <Renderer response={oul} library={library} isStreaming={streaming} />;
}
