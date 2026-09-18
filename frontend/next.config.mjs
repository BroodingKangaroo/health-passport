import createNextIntlPlugin from 'next-intl/plugin'

/** @type {import('next').NextConfig} */
const staticProxy = process.env.STATIC_PROXY_URL || 'http://localhost:8000'

const nextConfig = {
  output: 'standalone',
  // Next 16.3 auto-generates `AGENTS.md` + `CLAUDE.md` in this directory when it
  // detects an AI coding agent. This repo keeps one curated instruction file at
  // the repo root, so generated duplicates here would only add drift.
  agentRules: false,
  // `src/app/global-not-found.tsx` needs this flag in Next 16.2 (it is the
  // documented mechanism; the convention becomes default once stable). The app
  // has two ROOT layouts (the `(app)` and `(public)` route groups) and no
  // `app/layout.tsx`, so without a global-not-found an unmatched URL would
  // render Next's bare built-in document instead of the app's styled shell.
  experimental: {
    globalNotFound: true,
  },
  images: {
    unoptimized: true,
  },
  transpilePackages: ['recharts'],
  async rewrites() {
    return [
      {
        source:
          '/api/:path((?!auth/session|auth/csrf|auth/signin|auth/signout|auth/callback|auth/providers|auth/error|auth/_log).*)',
        destination: `${staticProxy}/api/:path`,
      },
      {
        source: '/static/:path*',
        destination: `${staticProxy}/static/:path*`,
      },
    ]
  },
}

// Locates src/i18n/request.ts for next-intl (cookie-driven locale, no URL routing).
const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts')

export default withNextIntl(nextConfig)
