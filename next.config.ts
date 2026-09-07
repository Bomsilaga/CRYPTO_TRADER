import type { NextConfig } from "next";
const nextConfig: NextConfig = {
  serverExternalPackages: ["web-push"],
  outputFileTracingRoot: process.cwd(),
};
export default nextConfig;
