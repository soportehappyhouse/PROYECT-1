import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Lint runs separately with the monorepo ESLint 9 flat config (`pnpm lint`).
  eslint: { ignoreDuringBuilds: true },
  // Workspace packages are consumed from their built `dist/` (ESM).
  transpilePackages: ["@studio/shared"],
};

export default nextConfig;
