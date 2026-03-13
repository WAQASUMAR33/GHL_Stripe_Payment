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
        // Allow the checkout iframe to be embedded by GHL order forms
        // (which may be on gohighlevel.com, leadconnectorhq.com, or
        //  any custom domain the merchant uses).
        // X-Frame-Options is intentionally omitted — it only supports DENY /
        // SAMEORIGIN; "ALLOWALL" is non-standard and browsers block it.
        // CSP frame-ancestors takes precedence in all modern browsers.
        source: '/checkout',
        headers: [
          { key: 'Content-Security-Policy', value: "frame-ancestors *" },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
