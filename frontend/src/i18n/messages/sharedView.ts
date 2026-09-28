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
        dob: 'Date of birth {date}',
        lastUpdated: 'Last updated {date}',
        expires: 'This link expires {date}. The owner can revoke it at any time.',
        readOnly: 'Read-only',
      },
      language: {
        label: 'Language',
        en: 'English',
        ru: 'Russian',
      },
      viewSwitch: {
        label: 'View',
        summary: 'Summary',
        full: 'Full record',
      },
      rail: {
        navigation: 'Sections',
      },
      flags: {
        title: 'Needs attention',
        empty: 'No results outside the reference range in this record.',
        reference: 'Reference range',
        measured: 'Measured {date}',
        colBiomarker: 'Biomarker',
        colLatest: 'Latest result',
        colStatus: 'Status',
        count:
          '{n, plural, one {# of {m} readings is outside the reference range} other {# of {m} readings are outside the reference range}}',
      },
      trends: {
        title: 'What changed',
        pointLabel: '{value}, measured {date}',
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
      // The full record's correlation section (ST3). The chart itself is the
      // app's own component, so its strings come from the `correlation` and
      // `charts` namespaces; these lines are the recipient's framing, which
      // the owner's surface does not need.
      correlation: {
        title: 'Correlation',
        intro:
          'Two measurements that tend to move together across the same dates. This is an exploratory look at this record, not a diagnosis, and it does not show that one measurement causes another.',
        show: 'Show correlation chart',
        loading: 'Loading chart...',
        empty:
          'Comparing biomarkers needs readings from at least two different ones. This record does not have that yet.',
        caveat:
          'Correlation is a statistical observation about this record alone. If a result here puzzles you, ask the person who shared it or their doctor.',
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
        dob: 'Дата рождения {date}',
        lastUpdated: 'Обновлено {date}',
        expires: 'Ссылка действует до {date}. Владелец может отозвать её в любой момент.',
        readOnly: 'Только просмотр',
      },
      language: {
        label: 'Язык',
        en: 'Английский',
        ru: 'Русский',
      },
      viewSwitch: {
        label: 'Вид',
        summary: 'Кратко',
        full: 'Вся карта',
      },
      rail: {
        navigation: 'Разделы',
      },
      flags: {
        title: 'Требует внимания',
        empty: 'В этой карте нет результатов вне референсного диапазона.',
        reference: 'Референсный диапазон',
        measured: 'Измерено {date}',
        colBiomarker: 'Показатель',
        colLatest: 'Последний результат',
        colStatus: 'Статус',
        count:
          // No separate few/many branches: the noun after "из {m}" is genitive
          // plural for every count ("2 из 12 показателей"), which `other`
          // already covers.
          '{n, plural, one {# из {m} показателей вне референсного диапазона} other {# из {m} показателей вне референсного диапазона}}',
      },
      trends: {
        title: 'Что изменилось',
        pointLabel: '{value}, измерено {date}',
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
      correlation: {
        title: 'Корреляции',
        intro:
          'Два показателя, которые меняются согласованно в одни и те же даты. Это исследовательский взгляд на запись, а не диагноз, и он не означает, что одно измерение вызывает другое.',
        show: 'Показать график корреляций',
        loading: 'Загрузка графика...',
        empty:
          'Для сравнения нужны измерения хотя бы двух разных биомаркеров. В этой записи их пока нет.',
        caveat:
          'Корреляция — статистическое наблюдение только по этой записи. Если какой-то результат непонятен, спросите того, кто поделился записью, или его врача.',
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
