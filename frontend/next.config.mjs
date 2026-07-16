/** @type {import('next').NextConfig} */
const staticProxy = process.env.STATIC_PROXY_URL || 'http://localhost:8000'

const nextConfig = {
  output: 'standalone',
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

export default nextConfig
