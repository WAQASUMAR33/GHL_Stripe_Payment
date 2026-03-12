/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Prevent webpack from trying to bundle Prisma's native binaries.
  // Without this, Next.js 15 App Router will attempt to bundle @prisma/client
  // (including its platform-specific query engine), causing build failures.
  serverExternalPackages: ['@prisma/client', 'prisma'],
  // Allow cross-origin requests from GHL iframes
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: 'ALLOWALL' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'self' https://*.gohighlevel.com https://*.leadconnectorhq.com" },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
