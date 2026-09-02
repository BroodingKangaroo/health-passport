import { sharedMessages } from './shared'
import { authMessages } from './auth'
import { addEntryMessages } from './addEntry'
import { timelineMessages } from './timeline'
import { correlationMessages } from './correlation'
import { printMessages } from './print'
import { settingsMessages } from './settings'
import { landingMessages } from './landing'

export const DEFAULT_LOCALE = 'en'
export const SUPPORTED_LOCALES = ['en', 'ru'] as const
export type AppLocale = (typeof SUPPORTED_LOCALES)[number]

function merge(...parts: Record<string, unknown>[]) {
  return Object.assign({}, ...parts)
}

export const messages: Record<AppLocale, Record<string, unknown>> = {
  en: merge(
    sharedMessages.en,
    authMessages.en,
    addEntryMessages.en,
    timelineMessages.en,
    correlationMessages.en,
    printMessages.en,
    settingsMessages.en,
    landingMessages.en,
  ),
  ru: merge(
    sharedMessages.ru,
    authMessages.ru,
    addEntryMessages.ru,
    timelineMessages.ru,
    correlationMessages.ru,
    printMessages.ru,
    settingsMessages.ru,
    landingMessages.ru,
  ),
}

export { sharedMessages, authMessages, addEntryMessages, timelineMessages, correlationMessages, printMessages, settingsMessages, landingMessages }
