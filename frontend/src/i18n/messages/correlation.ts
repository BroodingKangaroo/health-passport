// Insights & Correlation view and chart.
// Rooted under `correlation` so `useTranslations('correlation...')` resolves
// after the domain merge in messages/index.ts.
export const correlationMessages = {
  en: {
    correlation: {
      view: {
        loading: 'Loading...',
        failedToLoad: 'Failed to load data. Is the backend running?',
      },
      tabs: {
        topPairs: 'Top correlated pairs',
        select: 'Select biomarkers',
      },
      heading: 'Biomarker Correlation Dynamics',
      subtitle: 'Comparing normalized trends across selected biomarkers',
      searchPlaceholder: 'Search...',
      readingsCount: '{count, plural, other {# readings}}',
      stats: {
        heading: 'Pairwise correlation',
        needPaired:
          'Need at least 2 paired readings on shared dates to compute correlation.',
      },
      topPairs: {
        hint: 'by |r| · strongest first',
        rowTitle: '{a} × {b} — {strength}, {readings}, {confidence}',
      },
      strength: {
        composed: '{strength} {direction}',
        strong: 'Strong',
        moderate: 'Moderate',
        weak: 'Weak',
        positive: 'positive',
        negative: 'negative',
        negligible: 'Negligible',
      },
      confidence: {
        tooFew: 'too few readings to tell',
        real: 'likely a real relationship',
        chance: 'could still be chance',
      },
      empty: {
        noData: 'No biomarker data yet — add a blood test to get started.',
        noPairs: 'No pairs with 5+ shared readings yet — check the {tab} tab.',
        noMatching: 'No matching biomarkers.',
        selectAtLeastOne:
          'Select at least one biomarker to display the correlation chart.',
        noNumeric: 'No numeric readings to chart for the selected biomarkers.',
      },
      legend: {
        intro:
          'r (correlation) runs from −1 to +1: how closely two biomarkers move together.',
        rPlusOne: 'r = 1',
        afterPlusOne: ': perfectly in sync — they rise and fall together.',
        rMinusOne: 'r = −1',
        afterMinusOne: ': perfect mirror — one rises while the other falls.',
        confidence:
          '“Likely a real relationship” means there is less than a 5% chance this link is coincidence.',
      },
    },
  },
  ru: {
    correlation: {
      view: {
        loading: 'Загрузка...',
        failedToLoad: 'Не удалось загрузить данные. Проверьте, работает ли сервер.',
      },
      tabs: {
        topPairs: 'Топ коррелирующих пар',
        select: 'Выбор биомаркеров',
      },
      heading: 'Динамика корреляций биомаркеров',
      subtitle: 'Сравнение нормализованных трендов выбранных биомаркеров',
      searchPlaceholder: 'Поиск...',
      readingsCount:
        '{count, plural, one {# показание} few {# показания} many {# показаний} other {# показания}}',
      stats: {
        heading: 'Парные корреляции',
        needPaired:
          'Для расчёта корреляции нужно не менее 2 пар показаний на общие даты.',
      },
      topPairs: {
        hint: 'по |r| · сильнейшие сверху',
        rowTitle: '{a} × {b} — {strength}, {readings}, {confidence}',
      },
      strength: {
        composed: '{strength} {direction}',
        strong: 'Сильная',
        moderate: 'Умеренная',
        weak: 'Слабая',
        positive: 'прямая',
        negative: 'обратная',
        negligible: 'Незначительная',
      },
      confidence: {
        tooFew: 'слишком мало показаний для вывода',
        real: 'вероятно, реальная взаимосвязь',
        chance: 'возможно, случайное совпадение',
      },
      empty: {
        noData:
          'Пока нет данных по биомаркерам — добавьте анализ крови, чтобы начать.',
        noPairs:
          'Пока нет пар с 5+ общими показаниями — откройте вкладку «{tab}».',
        noMatching: 'Подходящих биомаркеров не найдено.',
        selectAtLeastOne:
          'Выберите хотя бы один биомаркер, чтобы построить график корреляций.',
        noNumeric:
          'Для выбранных биомаркеров нет числовых показаний для построения графика.',
      },
      legend: {
        intro:
          'r (корреляция) меняется от −1 до +1: насколько тесно два биомаркера движутся вместе.',
        rPlusOne: 'r = 1',
        afterPlusOne: ': идеальная синхронность — они растут и падают вместе.',
        rMinusOne: 'r = −1',
        afterMinusOne:
          ': идеальное зеркальное отражение — один растёт, пока другой падает.',
        confidence:
          '«Вероятно, реальная взаимосвязь» означает, что вероятность случайного совпадения составляет менее 5%.',
      },
    },
  },
} as const
