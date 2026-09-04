/**
 * Demo data for the /demo marketing surface — a completely fictional
 * patient, clinic, doctor, and clinical narrative. No real person's data is
 * used anywhere in this fixture: values are authored (not copied from any
 * real document) to exercise the product's status model — interval low /
 * normal / high and qualitative normal / abnormal — and to tell a small
 * coherent story (iron deficiency and H. pylori found, treated at the
 * doctor visit, improving on the repeat panel).
 *
 * Dates are relativized at build time (day offsets from "now") so the demo
 * never ages. Qualitative values use the backend's canonical English enum
 * ("Detected" / "Not detected"); the raw Russian document text lives in the
 * original_* fields, matching how a real `source_language: 'ru'` entry is
 * serialized. Entry-level fields mirror the extraction save path
 * (status 'Completed', category 'Labs').
 */

import type {
  BiomarkerDefinition,
  BiomarkerResult,
  EventType,
  MedicalEvent,
  Reading,
  Reference,
  Status,
  TimelineResponse,
  VisitData,
  VisitNote,
  VisitPrescription,
} from '@/lib/types'

export type DemoLocale = 'en' | 'ru'

function daysAgoIso(now: Date, days: number): string {
  const d = new Date(now)
  d.setDate(d.getDate() - days)
  return d.toISOString().slice(0, 10)
}

// Demo event ids. History readings reference these, so they double as
// foreign keys inside the fixture.
export const DEMO_BT1_ID = 'demo-bt-1' // 45 days ago — first panel
export const DEMO_BT2_ID = 'demo-bt-2' // 3 days ago — repeat panel
export const DEMO_VISIT_ID = 'demo-visit-1' // 10 days ago — doctor visit

const COPY = {
  en: {
    btTitle: 'Blood test — CBC & biochemistry',
    visitTitle: 'Gastroenterologist consultation',
    clinic: 'VitaMed Diagnostics',
    provider: 'Dr. Anna Volkova',
    specialty: 'Gastroenterology',
  },
  ru: {
    btTitle: 'Анализ крови — ОАК и биохимия',
    visitTitle: 'Консультация гастроэнтеролога',
    clinic: 'ВитаМед Диагностика',
    provider: 'Волкова Анна Сергеевна',
    specialty: 'Гастроэнтерология',
  },
} as const

interface DemoReadingSpec {
  value: number | string
  status: Status
  // The raw document string as printed on the (fictional) Russian lab form.
  originalValue: string
}

interface DemoDefSpec {
  id: string
  nameEn: string
  nameRu: string
  unit: string
  category: string
  reference: Reference
  originalName: string
  originalUnit: string
  originalRange: string
  bt1: DemoReadingSpec | null
  bt2: DemoReadingSpec | null
}

function interval(low: number | null, high: number | null): Reference {
  return { kind: 'interval', low, high }
}

const QUALITATIVE_EXPECTED = 'Not detected'

const DEFS: DemoDefSpec[] = [
  {
    id: 'demo-hemoglobin',
    nameEn: 'Hemoglobin',
    nameRu: 'Гемоглобин',
    unit: 'g/L',
    category: 'Hematology',
    reference: interval(120, 160),
    originalName: 'Гемоглобин',
    originalUnit: 'г/л',
    originalRange: '120-160',
    bt1: { value: 112, status: 'low', originalValue: '112' },
    bt2: { value: 118, status: 'low', originalValue: '118' },
  },
  {
    id: 'demo-rbc',
    nameEn: 'Erythrocytes (RBC)',
    nameRu: 'Эритроциты',
    unit: '10^12/L',
    category: 'Hematology',
    reference: interval(4.0, 5.5),
    originalName: 'Эритроциты',
    originalUnit: '10¹²/л',
    originalRange: '4,0-5,5',
    bt1: { value: 4.6, status: 'normal', originalValue: '4,6' },
    bt2: { value: 4.7, status: 'normal', originalValue: '4,7' },
  },
  {
    id: 'demo-wbc',
    nameEn: 'Leukocytes (WBC)',
    nameRu: 'Лейкоциты',
    unit: '10^9/L',
    category: 'Hematology',
    reference: interval(4.0, 9.0),
    originalName: 'Лейкоциты',
    originalUnit: '10⁹/л',
    originalRange: '4,0-9,0',
    bt1: { value: 6.4, status: 'normal', originalValue: '6,4' },
    bt2: { value: 6.9, status: 'normal', originalValue: '6,9' },
  },
  {
    id: 'demo-platelets',
    nameEn: 'Platelets',
    nameRu: 'Тромбоциты',
    unit: '10^9/L',
    category: 'Hematology',
    reference: interval(180, 320),
    originalName: 'Тромбоциты',
    originalUnit: '10⁹/л',
    originalRange: '180-320',
    bt1: { value: 245, status: 'normal', originalValue: '245' },
    bt2: { value: 252, status: 'normal', originalValue: '252' },
  },
  {
    id: 'demo-ferritin',
    nameEn: 'Ferritin',
    nameRu: 'Ферритин',
    unit: 'mcg/L',
    category: 'Hematology',
    reference: interval(30, 400),
    originalName: 'Ферритин',
    originalUnit: 'мкг/л',
    originalRange: '30-400',
    bt1: { value: 12, status: 'low', originalValue: '12' },
    bt2: { value: 38, status: 'normal', originalValue: '38' },
  },
  {
    id: 'demo-glucose',
    nameEn: 'Glucose',
    nameRu: 'Глюкоза',
    unit: 'mmol/L',
    category: 'Biochemistry',
    reference: interval(3.9, 6.1),
    originalName: 'Глюкоза',
    originalUnit: 'ммоль/л',
    originalRange: '3,9-6,1',
    bt1: { value: 5.2, status: 'normal', originalValue: '5,2' },
    bt2: { value: 5.4, status: 'normal', originalValue: '5,4' },
  },
  {
    id: 'demo-cholesterol-total',
    nameEn: 'Cholesterol, total',
    nameRu: 'Холестерин общий',
    unit: 'mmol/L',
    category: 'Biochemistry',
    reference: interval(null, 5.2),
    originalName: 'Холестерин общий',
    originalUnit: 'ммоль/л',
    originalRange: '< 5,2',
    bt1: { value: 5.9, status: 'high', originalValue: '5,9' },
    bt2: { value: 6.1, status: 'high', originalValue: '6,1' },
  },
  {
    id: 'demo-crp',
    nameEn: 'C-Reactive Protein',
    nameRu: 'СРБ',
    unit: 'mg/L',
    category: 'Biochemistry',
    reference: interval(null, 5.0),
    originalName: 'СРБ',
    originalUnit: 'мг/л',
    originalRange: '< 5,0',
    bt1: { value: 6.8, status: 'high', originalValue: '6,8' },
    bt2: { value: 2.1, status: 'normal', originalValue: '2,1' },
  },
  {
    id: 'demo-alt',
    nameEn: 'Alanine Aminotransferase (ALT)',
    nameRu: 'АЛТ',
    unit: 'U/L',
    category: 'Biochemistry',
    reference: interval(null, 41),
    originalName: 'АЛТ',
    originalUnit: 'Ед/л',
    originalRange: '< 41',
    bt1: { value: 26, status: 'normal', originalValue: '26' },
    bt2: { value: 24, status: 'normal', originalValue: '24' },
  },
  {
    id: 'demo-creatinine',
    nameEn: 'Creatinine',
    nameRu: 'Креатинин',
    unit: 'μmol/L',
    category: 'Biochemistry',
    reference: interval(62, 115),
    originalName: 'Креатинин',
    originalUnit: 'мкмоль/л',
    originalRange: '62-115',
    bt1: { value: 82, status: 'normal', originalValue: '82' },
    bt2: { value: 85, status: 'normal', originalValue: '85' },
  },
  {
    id: 'demo-tsh',
    nameEn: 'Thyroid Stimulating Hormone (TSH)',
    nameRu: 'ТТГ',
    unit: 'mIU/L',
    category: 'Endocrinology',
    reference: interval(0.4, 4.0),
    originalName: 'ТТГ',
    originalUnit: 'мЕД/л',
    originalRange: '0,4-4,0',
    bt1: { value: 2.4, status: 'normal', originalValue: '2,4' },
    bt2: { value: 2.1, status: 'normal', originalValue: '2,1' },
  },
  {
    id: 'demo-vitamin-d',
    nameEn: 'Vitamin D (25-OH)',
    nameRu: 'Витамин D (25-OH)',
    unit: 'ng/mL',
    category: 'Endocrinology',
    reference: interval(30, 100),
    originalName: 'Витамин D (25-OH)',
    originalUnit: 'нг/мл',
    originalRange: '30-100',
    bt1: { value: 14, status: 'low', originalValue: '14' },
    bt2: { value: 34, status: 'normal', originalValue: '34' },
  },
  {
    id: 'demo-h-pylori',
    nameEn: 'Helicobacter pylori antigen (stool)',
    nameRu: 'Антиген Helicobacter pylori (кал)',
    unit: '',
    category: 'Microbiology',
    reference: { kind: 'qualitative', expected: QUALITATIVE_EXPECTED },
    originalName: 'Антиген Helicobacter pylori',
    originalUnit: '',
    originalRange: 'Не обнаружено',
    bt1: { value: 'Detected', status: 'abnormal', originalValue: 'Обнаружено' },
    bt2: { value: 'Not detected', status: 'normal', originalValue: 'Не обнаружено' },
  },
]

function definitionOf(spec: DemoDefSpec): BiomarkerDefinition {
  return {
    id: spec.id,
    loinc_code: null,
    names: { en: spec.nameEn, ru: spec.nameRu },
    synonyms: [],
    unit: spec.unit,
    reference: spec.reference,
    category: spec.category,
    scope: 'local',
    reference_source: 'global',
    canonical_unit: spec.unit,
    canonical_kind: 'linear',
    canonical_unit_inferred: false,
  }
}

function readingOf(
  spec: DemoDefSpec,
  r: DemoReadingSpec,
  entryId: string,
  date: string,
): Reading {
  return {
    entry_id: entryId,
    date,
    value: r.value,
    status: r.status,
    reference: spec.reference,
    original_name: spec.originalName,
    original_value: r.originalValue,
    original_unit: spec.originalUnit,
    original_range: spec.originalRange,
    scale_function: null,
    needs_review: false,
    merged: false,
    merged_source: null,
  }
}

function visitNotes(locale: DemoLocale): VisitNote[] {
  const headingComplaints = locale === 'ru' ? 'Жалобы' : 'Complaints'
  const headingObjective = locale === 'ru' ? 'Объективно' : 'Objective findings'
  return [
    {
      heading: headingComplaints,
      text_original: 'Периодический дискомфорт в эпигастральной области после еды, повышенная утомляемость в течение последнего месяца.',
      text_translated: 'Occasional discomfort in the upper abdomen after meals; increased fatigue over the past month.',
    },
    {
      heading: headingObjective,
      text_original: 'Живот мягкий, болезненность в эпигастрии при пальпации. Общее состояние удовлетворительное.',
      text_translated: 'Abdomen soft, mild tenderness on palpation of the epigastric region. General condition satisfactory.',
    },
  ]
}

function visitPrescriptions(): VisitPrescription[] {
  return [
    {
      id: 1,
      name: { original: 'Препарат железа', translated_en: 'Iron supplement' },
      dose: { original: '100 мг', translated_en: '100 mg' },
      instruction: {
        original: 'Один раз в день с витамином C, 2 месяца',
        translated_en: 'Once daily with vitamin C, for 2 months',
      },
    },
    {
      id: 2,
      name: { original: 'Витамин D', translated_en: 'Vitamin D' },
      dose: { original: '2000 МЕ', translated_en: '2000 IU' },
      instruction: {
        original: 'Один раз в день во время еды, 3 месяца',
        translated_en: 'Once daily with a meal, for 3 months',
      },
    },
    {
      id: 3,
      name: {
        original: 'Эрадикационная терапия H. pylori',
        translated_en: 'H. pylori eradication therapy',
      },
      dose: { original: 'Курс 14 дней', translated_en: '14-day course' },
      instruction: {
        original: 'По схеме; не прерывать курс',
        translated_en: 'As prescribed; do not interrupt the course',
      },
    },
  ]
}

function visitRecommendations(): { original: string; translated_en: string }[] {
  return [
    {
      original: 'Повторить общий и биохимический анализ крови через 2 месяца.',
      translated_en: 'Repeat the blood panel in 2 months.',
    },
    {
      original: 'Контрольный тест на антиген H. pylori через 4 недели после окончания терапии.',
      translated_en: 'Repeat the H. pylori antigen test 4 weeks after finishing the therapy.',
    },
    {
      original: 'Регулярное питание; ограничить жареное и острое.',
      translated_en: 'Regular meals; limit fried and spicy foods.',
    },
  ]
}

function visitDataOf(
  locale: DemoLocale,
  date: string,
): VisitData {
  return {
    specialty: COPY[locale].specialty,
    provider: COPY[locale].provider,
    date,
    clinic: COPY[locale].clinic,
    verdict: {
      original:
        'Хронический гастрит, ассоциированный с H. pylori. Железодефицитная анемия лёгкой степени. Дефицит витамина D.',
      translated_en:
        'Chronic gastritis associated with H. pylori. Mild iron deficiency anemia. Vitamin D deficiency.',
    },
    notes: visitNotes(locale),
    prescriptions: visitPrescriptions(),
    recommendations: visitRecommendations(),
    attachments: [],
  }
}

/**
 * Build the full demo timeline. `now` defaults to the current date; tests
 * pass a fixed date for deterministic assertions.
 */
export function buildDemoTimeline(
  locale: DemoLocale,
  now: Date = new Date(),
): TimelineResponse {
  const bt1Date = daysAgoIso(now, 45)
  const visitDate = daysAgoIso(now, 10)
  const bt2Date = daysAgoIso(now, 3)

  const event = (
    id: string,
    type: EventType,
    date: string,
    title: string,
    status: string,
  ): MedicalEvent => ({
    id,
    date,
    type,
    title,
    clinic: COPY[locale].clinic,
    subtitle: '',
    category: type === 'blood_test' ? 'Labs' : '',
    status,
    attachments: [],
    source_language: 'ru',
  })

  const events: MedicalEvent[] = [
    event(DEMO_BT1_ID, 'blood_test', bt1Date, COPY[locale].btTitle, 'Completed'),
    event(DEMO_VISIT_ID, 'doctor_visit', visitDate, COPY[locale].visitTitle, ''),
    event(DEMO_BT2_ID, 'blood_test', bt2Date, COPY[locale].btTitle, 'Completed'),
  ]

  const biomarkers: BiomarkerResult[] = DEFS.map((spec) => {
    const readings: { entryId: string; date: string; spec: DemoReadingSpec }[] = []
    if (spec.bt1) readings.push({ entryId: DEMO_BT1_ID, date: bt1Date, spec: spec.bt1 })
    if (spec.bt2) readings.push({ entryId: DEMO_BT2_ID, date: bt2Date, spec: spec.bt2 })
    // Latest reading is the top level; older ones become history (the same
    // oldest-first layout the /api/timeline serializer produces).
    const latest = readings[readings.length - 1]
    const history = readings.slice(0, -1).map((r) =>
      readingOf(spec, r.spec, r.entryId, r.date),
    )
    return {
      id: spec.id,
      entry_id: latest.entryId,
      definition: definitionOf(spec),
      value: latest.spec.value,
      date: latest.date,
      status: latest.spec.status,
      history,
      reference: spec.reference,
      original_name: spec.originalName,
      original_value: latest.spec.originalValue,
      original_unit: spec.originalUnit,
      original_range: spec.originalRange,
      merged: false,
      merged_source: null,
      scale_function: null,
      needs_review: false,
    }
  })

  const visits: Record<string, VisitData> = {
    [DEMO_VISIT_ID]: visitDataOf(locale, visitDate),
  }

  return { events, biomarkers, visits, instrumental: {} }
}
