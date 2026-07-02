/** @type {import('next').NextConfig} */
const staticProxy = process.env.STATIC_PROXY_URL || 'http://localhost:8000'

const nextConfig = {
  output: 'standalone',
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  transpilePackages: ['recharts'],
  async rewrites() {
    return [
      {
        source: '/static/:path*',
        destination: `${staticProxy}/static/:path*`,
      },
    ]
  },
}

export default nextConfig
