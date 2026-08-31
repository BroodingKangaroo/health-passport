/**
 * Locale access for NON-REACT modules (services/api.ts and friends) that cannot
 * call `useLocale()`. The locale is read from the same `NEXT_LOCALE` cookie
 * that drives `src/i18n/request.ts` on the server. Server-side rendering of
 * these modules has no cookie access and defaults to English — acceptable,
 * because these strings are only produced inside event handlers (fetch
 * failures), never during initial render.
 *
 * NOTE: the English strings here are the API-contract fallbacks asserted by
 * `src/services/__tests__/api-error-detail.test.ts` — do not reword them.
 */
export type ApiLocale = 'en' | 'ru'

export function getApiLocale(): ApiLocale {
  if (typeof document === 'undefined') return 'en'
  const match = document.cookie.match(/(?:^|;\s*)NEXT_LOCALE=(en|ru)(?:;|$)/)
  return match ? (match[1] as ApiLocale) : 'en'
}

/**
 * Persist the chosen UI locale in the NEXT_LOCALE cookie — the single source
 * of truth read by src/i18n/request.ts (server) and getApiLocale() (client).
 * Lives in this plain module (not the component) so the React-compiler lint
 * rule against global mutation during render doesn't fire.
 */
export function setLocaleCookie(locale: ApiLocale): void {
  if (typeof document === 'undefined') return
  document.cookie = `NEXT_LOCALE=${locale}; path=/; max-age=31536000; samesite=lax`
}

const API_FALLBACKS = {
  en: {
    usageLimitReached: 'Usage limit reached',
    postEntryFailed: 'POST /entry failed',
    postEntryMergeFailed: 'POST /entry/merge failed',
    postExtractFailed: 'POST /extract failed',
    postTranslateFailed: 'POST /translate-biomarkers failed',
    postTranslateCommitFailed: 'POST /translate-biomarkers/commit failed',
    deleteEntryFailed: 'DELETE /entry failed',
    exportFailed: 'GET /export failed',
    changePasswordFailed: 'POST /auth/change-password failed',
    deleteAccountFailed: 'DELETE /auth/account failed',
    registerFailed: 'POST /auth/register failed',
    extractionFailed: 'Extraction failed',
    extractionTimedOut:
      'AI extraction timed out — the connection stalled. Please try again.',
    translationTimedOut:
      'Translation timed out — the AI service did not respond in time. Please try again.',
  },
  ru: {
    usageLimitReached: 'Достигнут лимит использования',
    postEntryFailed: 'Не удалось сохранить запись',
    postEntryMergeFailed: 'Не удалось объединить записи',
    postExtractFailed: 'Не удалось выполнить распознавание',
    postTranslateFailed: 'Не удалось перевести названия',
    postTranslateCommitFailed: 'Не удалось сохранить перевод',
    deleteEntryFailed: 'Не удалось удалить запись',
    exportFailed: 'Не удалось экспортировать данные',
    changePasswordFailed: 'Не удалось изменить пароль',
    deleteAccountFailed: 'Не удалось удалить аккаунт',
    registerFailed: 'Не удалось зарегистрироваться',
    extractionFailed: 'Не удалось распознать документ',
    extractionTimedOut:
      'Время ожидания распознавания истекло — соединение прервалось. Попробуйте ещё раз.',
    translationTimedOut:
      'Время ожидания перевода истекло — сервис не ответил. Попробуйте ещё раз.',
  },
} as const

export type ApiFallbackKey = keyof (typeof API_FALLBACKS)['en']

export function apiFallback(key: ApiFallbackKey): string {
  return API_FALLBACKS[getApiLocale()][key]
}
