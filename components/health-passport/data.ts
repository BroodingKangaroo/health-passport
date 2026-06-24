import {
  Droplet,
  Stethoscope,
  Brain,
  type LucideIcon,
} from 'lucide-react'

export type Status = 'normal' | 'low' | 'high'

export interface HistoryEvent {
  id: string
  icon: LucideIcon
  title: string
  date: string
  subtext: string
  attachments?: number
}

export interface Reading {
  date: string
  value: number
  status: Status
}

export interface Biomarker {
  id: string
  name: string
  original: string
  result: string
  unit: string
  range: string
  rangeMin: number
  rangeMax: number
  status: Status
  history?: Reading[]
}

export const historyEvents: HistoryEvent[] = [
  {
    id: 'blood-oct',
    icon: Droplet,
    title: 'Blood Test Panel',
    date: 'Oct 12, 2026',
    subtext: 'Invitro Lab',
    attachments: 1,
  },
  {
    id: 'cardio',
    icon: Stethoscope,
    title: 'Cardiologist Visit',
    date: 'Sep 05, 2026',
    subtext: 'Clinical Notes',
  },
  {
    id: 'mri',
    icon: Brain,
    title: 'MRI Scan',
    date: 'Aug 20, 2026',
    subtext: 'Imaging Report',
  },
  {
    id: 'blood-jan',
    icon: Droplet,
    title: 'Blood Test Panel',
    date: 'Jan 15, 2026',
    subtext: 'KDL Lab',
    attachments: 1,
  },
]

export const biomarkers: Biomarker[] = [
  {
    id: 'hemoglobin',
    name: 'Hemoglobin',
    original: 'Гемоглобин',
    result: '142',
    unit: 'g/L',
    range: '130 - 170',
    rangeMin: 130,
    rangeMax: 170,
    status: 'normal',
  },
  {
    id: 'ferritin',
    name: 'Ferritin',
    original: 'Ферритин',
    result: '22',
    unit: 'ng/mL',
    range: '30 - 400',
    rangeMin: 30,
    rangeMax: 400,
    status: 'low',
    history: [
      { date: 'Jan 2024', value: 16.2, status: 'low' },
      { date: 'Aug 2025', value: 50.4, status: 'normal' },
      { date: 'Oct 2026', value: 22, status: 'low' },
    ],
  },
  {
    id: 'tsh',
    name: 'TSH',
    original: 'ТТГ',
    result: '2.1',
    unit: 'mIU/L',
    range: '0.4 - 4.0',
    rangeMin: 0.4,
    rangeMax: 4.0,
    status: 'normal',
  },
  {
    id: 'cholesterol',
    name: 'Cholesterol',
    original: 'Холестерин',
    result: '5.8',
    unit: 'mmol/L',
    range: '< 5.2',
    rangeMin: 0,
    rangeMax: 5.2,
    status: 'high',
  },
]

/* ----- Lab Flowsheet (Matrix) ----- */

export const flowsheetDates = [
  'Jan 15, 2026',
  'Mar 06, 2026',
  'Sep 05, 2026',
  'Oct 12, 2026',
] as const

export interface MatrixCell {
  value: string
  status: Status
}

export interface MatrixRow {
  id: string
  name: string
  original: string
  range: string
  cells: MatrixCell[]
}

export interface MatrixCategory {
  category: string
  rows: MatrixRow[]
}

export const flowsheetMatrix: MatrixCategory[] = [
  {
    category: 'Complete Blood Count (CBC)',
    rows: [
      {
        id: 'hemoglobin',
        name: 'Hemoglobin',
        original: 'Гемоглобин',
        range: '130 - 170',
        cells: [
          { value: '138', status: 'normal' },
          { value: '145', status: 'normal' },
          { value: '140', status: 'normal' },
          { value: '142', status: 'normal' },
        ],
      },
      {
        id: 'leukocytes',
        name: 'Leukocytes',
        original: 'Лейкоциты',
        range: '4.0 - 9.0',
        cells: [
          { value: '8.6', status: 'normal' },
          { value: '12.4', status: 'high' },
          { value: '9.1', status: 'high' },
          { value: '8.8', status: 'normal' },
        ],
      },
    ],
  },
  {
    category: 'Iron Panel',
    rows: [
      {
        id: 'ferritin',
        name: 'Ferritin',
        original: 'Ферритин',
        range: '30 - 400',
        cells: [
          { value: '16.2', status: 'low' },
          { value: '28.5', status: 'low' },
          { value: '32.0', status: 'normal' },
          { value: '22.0', status: 'low' },
        ],
      },
    ],
  },
]

/* ----- Biomarker Details (Ferritin deep-dive) ----- */

export const ferritinTrend: Reading[] = [
  { date: 'Jan 2024', value: 16.2, status: 'low' },
  { date: 'Aug 2024', value: 24.0, status: 'low' },
  { date: 'Feb 2025', value: 41.5, status: 'normal' },
  { date: 'Aug 2025', value: 50.4, status: 'normal' },
  { date: 'Mar 2026', value: 32.0, status: 'normal' },
  { date: 'Sep 2026', value: 28.5, status: 'low' },
  { date: 'Oct 2026', value: 22.0, status: 'low' },
]

export interface LogEntry {
  date: string
  value: number
  reference: string
  source: string
  delta: string
}

export const ferritinLog: LogEntry[] = [
  { date: 'Oct 12, 2026', value: 22.0, reference: '30 - 400', source: 'Invitro Lab', delta: '-6.5 from last' },
  { date: 'Sep 05, 2026', value: 28.5, reference: '30 - 400', source: 'Invitro Lab', delta: '-3.5 from last' },
  { date: 'Mar 06, 2026', value: 32.0, reference: '30 - 400', source: 'KDL Lab', delta: '-18.4 from last' },
  { date: 'Aug 18, 2025', value: 50.4, reference: '30 - 400', source: 'KDL Lab', delta: '+8.9 from last' },
  { date: 'Feb 02, 2025', value: 41.5, reference: '30 - 400', source: 'Helix Lab', delta: '+17.5 from last' },
  { date: 'Aug 10, 2024', value: 24.0, reference: '30 - 400', source: 'Helix Lab', delta: '+7.8 from last' },
  { date: 'Jan 20, 2024', value: 16.2, reference: '30 - 400', source: 'Invitro Lab', delta: 'Baseline' },
]
