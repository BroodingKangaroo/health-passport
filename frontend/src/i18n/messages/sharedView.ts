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
      error: {
        title: 'Не удалось загрузить эту запись.',
        body: 'Возможно, ссылка временно недоступна. Попробуйте ещё раз через минуту.',
        retry: 'Повторить',
      },
    },
  },
}
