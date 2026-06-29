/** @type {import('next').NextConfig} */
const nextConfig = {
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
        destination: 'http://localhost:8000/static/:path*',
      },
    ]
  },
}

export default nextConfig
