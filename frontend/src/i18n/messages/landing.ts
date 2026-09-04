// Landing hero shown at `/` to first-time and zero-data visitors.
// Copy follows the roadmap marketing principles: ownership on the first
// screen, decoding (not archiving) pitch, pro-doctor positioning, calm tone.
// The trial-extraction count is interpolated from /usage/limits
// (ai_extraction_limit), not hardcoded.
export const landingMessages = {
  en: {
    landing: {
      title: 'Your labs, decoded',
      subtitle:
        'HealthPassport turns scattered medical documents into one clear picture of your health — so you can arrive at your doctor informed and prepared.',
      ctaTry: 'Try without an account',
      ctaTryRegistered: 'Add your first entry',
      ctaDemo: 'See live example',
      ctaNote:
        '{count, plural, one {# free document extraction · no email required} other {# free document extractions · no email required}}',
      howTitle: 'How it works',
      howStep1Title: 'Upload a document',
      howStep1Text: "A photo or PDF of a lab report, a doctor's note, or a scan.",
      howStep2Title: 'We decode it',
      howStep2Text:
        'Every biomarker is read, standardized, and explained in plain language.',
      howStep3Title: 'See your story',
      howStep3Text: 'Track results over time and share a clear summary with your doctor.',
      badgeSectionLabel: 'Your data, your rules',
      badgeDeleteTitle: 'Delete everything, anytime',
      badgeDeleteText: 'Your data is yours. One click removes it all, for good.',
      badgeExportTitle: 'Export anytime',
      badgeExportText: 'Download a complete copy of your data whenever you want.',
      badgeTrialTitle: 'Anonymous trial',
      badgeTrialText:
        '{count, plural, one {# free document extraction — no email, no card} other {# free document extractions — no email, no card}}',
      privacyNote:
        'Documents are processed by an AI service and are not stored there. You can delete or export your data at any time.',
      privacyPolicyLink: 'Privacy policy',
    },
  },
  ru: {
    landing: {
      title: 'Ваши анализы — расшифрованы',
      subtitle:
        'HealthPassport превращает разрозненные медицинские документы в одну понятную картину здоровья — чтобы вы приходили к врачу информированными и подготовленными.',
      ctaTry: 'Попробовать без аккаунта',
      ctaTryRegistered: 'Добавьте первую запись',
      ctaDemo: 'Посмотреть на примере',
      ctaNote:
        '{count, plural, one {# бесплатная расшифровка документов · без email} few {# бесплатные расшифровки документов · без email} many {# бесплатных расшифровок документов · без email} other {# бесплатной расшифровки документов · без email}}',
      howTitle: 'Как это работает',
      howStep1Title: 'Загрузите документ',
      howStep1Text: 'Фото или PDF: результаты анализов, заключение врача, снимок.',
      howStep2Title: 'Мы расшифровываем',
      howStep2Text:
        'Каждый показатель будет распознан, приведён к стандарту и объяснён простым языком.',
      howStep3Title: 'Ваша история здоровья',
      howStep3Text: 'Отслеживайте результаты в динамике и делитесь ясной сводкой с врачом.',
      badgeSectionLabel: 'Ваши данные — ваши правила',
      badgeDeleteTitle: 'Удалить всё в любой момент',
      badgeDeleteText: 'Ваши данные — ваши. Один клик — и всё удалено безвозвратно.',
      badgeExportTitle: 'Экспорт в любой момент',
      badgeExportText: 'Скачайте полную копию своих данных, когда захотите.',
      badgeTrialTitle: 'Анонимный доступ',
      badgeTrialText:
        '{count, plural, one {# бесплатная расшифровка документов — без email и банковской карты} few {# бесплатные расшифровки документов — без email и банковской карты} many {# бесплатных расшифровок документов — без email и банковской карты} other {# бесплатных расшифровок документов — без email и банковской карты}}',
      privacyNote:
        'Документы обрабатываются ИИ-сервисом и не хранятся в нём. Вы можете удалить или экспортировать свои данные в любой момент.',
      privacyPolicyLink: 'Политика конфиденциальности',
    },
  },
} as const
