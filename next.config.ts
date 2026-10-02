import type { NextConfig } from "next";

// Preserve the repository-owned AGENTS.md during development.
const nextConfig: NextConfig = { agentRules: false };

export default nextConfig;
