// Copy for the recipient of a share link (the public /s/<token> surface).
// The reader has no account and no context for the app, so the framing words
// are deliberately plain ("needs attention", "outside the reference range")
// and never clinical claims.
export const sharedViewMessages = {
  en: {
    sharedView: {
      meta: {
        title: 'Shared health record',
      },
      orientation: {
        ownedBy: 'Health record of {name}',
        anonymous: 'A shared health record',
        lastUpdated: 'Last updated {date}',
        expires: 'This link expires {date}. The owner can revoke it at any time.',
        readOnly: 'Read-only',
      },
      language: {
        label: 'Language',
        en: 'English',
        ru: 'Russian',
      },
      flags: {
        title: 'Needs attention',
        empty: 'No results outside the reference range in this record.',
        reference: 'Reference range',
        measured: 'Measured {date}',
      },
      trends: {
        title: 'What changed',
        since: 'Since {date}',
      },
      history: {
        title: 'Visits, imaging and procedures',
        empty: 'No visits, imaging or procedures in this record.',
      },
      excluded: {
        note: 'Not shared through this link: {types}.',
        blood_test: 'lab results',
        doctor_visit: 'doctor visits',
        instrumental_test: 'imaging and other tests',
        procedure: 'procedures',
      },
      results: {
        title: 'All results',
        loading: 'Loading all results...',
        error: 'Could not load all results.',
        retry: 'Try again',
      },
      footer: {
        disclaimer:
          'This is a personal health record kept by its owner and shared with you at their invitation. It is not a medical opinion or a diagnosis.',
        cta: 'Make your own HealthPassport',
      },
      deadLink: {
        title: 'This link is no longer active.',
        body: 'If you still need this record, ask the person who shared it to send a new link.',
      },
      passcode: {
        title: 'This record is protected.',
        body: 'Enter the passcode the owner gave you to open it.',
        label: 'Passcode',
        submit: 'Open record',
        checking: 'Checking...',
        failed: 'That passcode is not correct.',
        throttled: 'Too many attempts. Try again in a few minutes.',
      },
      error: {
        title: 'Could not load this record.',
        body: 'The link may be temporarily unavailable. Try again in a moment.',
        retry: 'Try again',
      },
    },
  },
  ru: {
    sharedView: {
      meta: {
        title: 'Поделиться медицинской картой',
      },
      orientation: {
        ownedBy: 'Медицинская карта: {name}',
        anonymous: 'Медицинская карта, которой поделились',
        lastUpdated: 'Обновлено {date}',
        expires: 'Ссылка действует до {date}. Владелец может отозвать её в любой момент.',
        readOnly: 'Только просмотр',
      },
      language: {
        label: 'Язык',
        en: 'Английский',
        ru: 'Русский',
      },
      flags: {
        title: 'Требует внимания',
        empty: 'В этой карте нет результатов вне референсного диапазона.',
        reference: 'Референсный диапазон',
        measured: 'Измерено {date}',
      },
      trends: {
        title: 'Что изменилось',
        since: 'С {date}',
      },
      history: {
        title: 'Визиты, обследования и процедуры',
        empty: 'В этой карте нет визитов, обследований и процедур.',
      },
      excluded: {
        note: 'Не передаётся по этой ссылке: {types}.',
        blood_test: 'анализы',
        doctor_visit: 'визиты к врачу',
        instrumental_test: 'обследования и снимки',
        procedure: 'процедуры',
      },
      results: {
        title: 'Все результаты',
        loading: 'Загрузка всех результатов...',
        error: 'Не удалось загрузить все результаты.',
        retry: 'Повторить',
      },
      footer: {
        disclaimer:
          'Это личная медицинская карта, которую ведёт её владелец и которой он поделился с вами по своей инициативе. Это не медицинское заключение и не диагноз.',
        cta: 'Создайте свою HealthPassport',
      },
      deadLink: {
        title: 'Эта ссылка больше не активна.',
        body: 'Если запись всё ещё нужна, попросите того, кто ею поделился, отправить новую ссылку.',
      },
      passcode: {
        title: 'Эта запись защищена.',
        body: 'Введите код доступа, который вам дал владелец.',
        label: 'Код доступа',
        submit: 'Открыть запись',
        checking: 'Проверка...',
        failed: 'Неверный код доступа.',
        throttled: 'Слишком много попыток. Попробуйте ещё раз через несколько минут.',
      },
      error: {
        title: 'Не удалось загрузить эту запись.',
        body: 'Возможно, ссылка временно недоступна. Попробуйте ещё раз через минуту.',
        retry: 'Повторить',
      },
    },
  },
}
