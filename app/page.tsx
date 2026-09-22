import { redirect } from "next/navigation";
import { sessionUser } from "@/lib/auth";
export default async function Home() { redirect((await sessionUser()) ? "/app" : "/login"); }
