import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import type { NextConfig } from "next";

// Next only reads apps/web/.env*: take the API URL from the monorepo root .env (process env wins).
// Read at build and start time; NEXT_PUBLIC_* is inlined at build (start.ps1 rebuilds if .env changed).
const rootEnvFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.env");
const rootEnv = existsSync(rootEnvFile) ? parseEnv(readFileSync(rootEnvFile, "utf8")) : {};
const envValue = (key: string) => process.env[key]?.trim() || rootEnv[key]?.trim() || undefined;

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Lint runs separately with the monorepo ESLint 9 flat config (`pnpm lint`).
  eslint: { ignoreDuringBuilds: true },
  // Workspace packages are consumed from their built `dist/` (ESM).
  transpilePackages: ["@studio/shared"],
  env: {
    NEXT_PUBLIC_API_URL:
      envValue("NEXT_PUBLIC_API_URL") ?? `http://127.0.0.1:${envValue("API_PORT") ?? "3001"}`,
  },
};

export default nextConfig;
