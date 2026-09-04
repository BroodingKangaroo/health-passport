// /demo marketing surface — the "show, don't ask for trust" principle
// (roadmap principle 4): the real product rendered over a fictional patient.
export const demoMessages = {
  en: {
    demo: {
      badge: 'Demo',
      bannerTitle: 'Sample data from a fictional patient',
      bannerText:
        'This is what HealthPassport looks like once your documents are decoded. Nothing here is real and nothing is stored.',
      bannerCta: 'Upload your first document',
    },
  },
  ru: {
    demo: {
      badge: 'Демо',
      bannerTitle: 'Пример данных вымышленного пациента',
      bannerText:
        'Так выглядит HealthPassport, когда ваши документы расшифрованы. Здесь нет настоящих данных и ничего не хранится.',
      bannerCta: 'Загрузите свой первый документ',
    },
  },
} as const
