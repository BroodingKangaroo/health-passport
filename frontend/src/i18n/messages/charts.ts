// Shared chart chrome strings (axis mode toggle, warped-axis annotations).
// Each domain file exports { en, ru } message trees; `index.ts` merges them.
export const chartsMessages = {
  en: {
    charts: {
      axisMode: {
        label: 'Time axis scale for {name}',
        time: 'Time scale',
        even: 'Even spacing',
      },
      scaleNote: 'Long gaps are compressed — order stays chronological',
      gapMonths: '≈ {months} mo',
    },
  },
  ru: {
    charts: {
      axisMode: {
        label: 'Шкала времени: {name}',
        time: 'По времени',
        even: 'Равные промежутки',
      },
      scaleNote: 'Длинные перерывы сжаты — порядок хронологический',
      gapMonths: '≈ {months} мес',
    },
  },
} as const
