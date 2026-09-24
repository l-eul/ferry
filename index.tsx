import { createFileRoute } from "@tanstack/react-router";
import { FerryApp } from "@/components/ferry/ferry-app";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return <FerryApp />;
}
