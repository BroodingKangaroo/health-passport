import type { MetadataRoute } from 'next'

/**
 * A shared record is somebody's clinical data behind an unguessable URL; it
 * must never be crawled, and a crawled URL is a leaked URL. `/s/` is
 * disallowed here and the page itself sends `noindex` and `no-referrer`.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      disallow: '/s/',
    },
  }
}
