import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  serverExternalPackages: ['web-push', '@anthropic-ai/sdk'],
};

export default nextConfig;
