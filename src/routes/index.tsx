import { createFileRoute } from "@tanstack/react-router";
import { KgbApp } from "@/components/kgb-app";

export const Route = createFileRoute("/")({ component: KgbApp });
