// Privacy policy page (roadmap 0.2). Plain-language sections; the AI
// processing disclosure mirrors the upload-flow note. Flat sN keys keep the
// EN/RU parity test trivial (no array-structure mirroring).
export const privacyMessages = {
  en: {
    privacy: {
      title: 'Privacy Policy',
      updated: 'Last updated: September 2026',
      intro:
        'HealthPassport is built so that your medical data stays yours. This page explains what we collect and how it is processed — in plain language.',
      s1Title: 'What we collect',
      s1Text:
        'The documents you upload (photos or PDFs) and the structured results extracted from them. If you create an account: your email and password. If you use the anonymous trial: no email at all — only a session cookie.',
      s2Title: 'How AI processing works',
      s2Text:
        'Uploaded documents are sent to a third-party AI service (Mistral; OpenRouter for translations) to read and structure the data. The AI service processes your document to return the extracted results and does not store your documents. The extracted results are stored only in your HealthPassport account.',
      s3Title: 'Storage and control',
      s3Text:
        'Your data is stored in your account and is never sold or shared. You can export a complete copy of your data at any time, and delete everything at any time. The anonymous trial keeps nothing tied to your identity.',
      s4Title: 'Not medical advice',
      s4Text:
        'HealthPassport organizes and explains lab results, but it does not replace professional medical advice. Always discuss your results with your doctor.',
    },
  },
  ru: {
    privacy: {
      title: 'Политика конфиденциальности',
      updated: 'Обновлено: сентябрь 2026',
      intro:
        'HealthPassport создан так, чтобы ваши медицинские данные оставались вашими. На этой странице простым языком объяснено, что мы собираем и как это обрабатывается.',
      s1Title: 'Что мы собираем',
      s1Text:
        'Документы, которые вы загружаете (фото или PDF), и структурированные результаты, извлечённые из них. Если вы создаёте аккаунт: email и пароль. Если пользуетесь анонимным доступом: email не нужен вообще — только cookie сессии.',
      s2Title: 'Как работает ИИ-обработка',
      s2Text:
        'Загруженные документы отправляются в сторонний ИИ-сервис (Mistral; OpenRouter для переводов), который распознаёт и структурирует данные. ИИ-сервис обрабатывает ваш документ, чтобы вернуть извлечённые результаты, и не хранит ваши документы. Извлечённые результаты хранятся только в вашем аккаунте HealthPassport.',
      s3Title: 'Хранение и контроль',
      s3Text:
        'Ваши данные хранятся в вашем аккаунте и никогда не продаются и не передаются третьим лицам. Вы можете в любой момент экспортировать полную копию своих данных или удалить всё. Анонимный доступ не связывает ничего с вашей личностью.',
      s4Title: 'Не является медицинской консультацией',
      s4Text:
        'HealthPassport упорядочивает и объясняет результаты анализов, но не заменяет профессиональную медицинскую консультацию. Обсуждайте результаты с вашим врачом.',
    },
  },
} as const
