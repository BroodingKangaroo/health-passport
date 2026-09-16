import Link from 'next/link'
import { getTranslations } from 'next-intl/server'

// Roadmap 0.2: the privacy policy must be live before any public launch.
// Server-rendered so the content is crawlable; localized via the UI-locale
// cookie like every other page.
export default async function PrivacyPage() {
  const t = await getTranslations('privacy')
  const sections = [
    { title: t('s1Title'), text: t('s1Text') },
    { title: t('s2Title'), text: t('s2Text') },
    { title: t('s3Title'), text: t('s3Text') },
    { title: t('s4Title'), text: t('s4Text') },
  ]

  return (
    <div className="min-h-screen bg-background">
      <main className="mx-auto max-w-2xl px-4 py-12 sm:py-16">
        <h1 className="text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
          {t('title')}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('updated')}</p>
        <p className="mt-6 text-pretty text-base text-muted-foreground">{t('intro')}</p>
        <div className="mt-8 flex flex-col gap-6">
          {sections.map((s) => (
            <section key={s.title} className="rounded-xl border border-border bg-card p-5">
              <h2 className="text-base font-semibold text-foreground">{s.title}</h2>
              <p className="mt-2 text-pretty text-sm text-muted-foreground">{s.text}</p>
            </section>
          ))}
        </div>
        <p className="mt-8">
          <Link href="/" className="text-sm text-primary hover:underline">
            HealthPassport
          </Link>
        </p>
      </main>
    </div>
  )
}
