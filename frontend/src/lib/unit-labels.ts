/**
 * Display-time translation of (canonical, English) unit strings.
 *
 * Units are precision-critical data — they are NEVER LLM-translated. This is
 * a curated static dictionary covering the dominant canonical units in the
 * database (LOINC UCUM forms plus matcher-anchored units like `copies/mL`);
 * anything not in the map passes through unchanged (UCUM is internationally
 * readable, so passthrough is safe and honest).
 *
 * Matching is normalized: trimmed, whitespace collapsed, `µ` unified to `u`,
 * case-insensitive — so `10*3/uL` and `10*3/µl` both hit the same entry.
 * Stored data is untouched; only render sites (timeline unit column,
 * flowsheet tooltip, print editor's reference line for `lang: 'ru'`) call
 * this.
 */

const UNIT_LABELS_RU: Record<string, string> = {
  // Concentration — mass
  'mg/dL': 'мг/дл',
  'mg/L': 'мг/л',
  'mg/mL': 'мг/мл',
  'ug/mL': 'мкг/мл',
  'ug/L': 'мкг/л',
  'ug/dL': 'мкг/дл',
  'ng/mL': 'нг/мл',
  'ng/L': 'нг/л',
  'ng/dL': 'нг/дл',
  'pg/mL': 'пг/мл',
  'pg/L': 'пг/л',
  'pg': 'пг',
  'g/L': 'г/л',
  'g/dL': 'г/дл',
  'ug/kg': 'мкг/кг',
  'ug/min': 'мкг/мин',
  // Concentration — molar
  'mol/L': 'моль/л',
  'mmol/L': 'ммоль/л',
  'umol/L': 'мкмоль/л',
  'nmol/L': 'нмоль/л',
  'pmol/L': 'пмоль/л',
  'mmol/mL': 'ммоль/мл',
  // Enzymatic / immune activity
  'U/L': 'Ед/л',
  'U/mL': 'Ед/мл',
  'mU/L': 'мЕд/л',
  'mU/mL': 'мЕд/мл',
  '[IU]/L': 'МЕ/л',
  '[IU]/mL': 'МЕ/мл',
  'IU/L': 'МЕ/л',
  'IU/mL': 'МЕ/мл',
  // Blood cells / CBC
  '10*3/uL': '×10³/мкл',
  '10*6/uL': '×10⁶/мкл',
  '10*9/L': '×10⁹/л',
  '10*12/L': '×10¹²/л',
  'fL': 'фл',
  // Forms produced by the backend's unit translation of Russian lab units
  // (e.g. units_guess.py: "кл/мкл" -> "/uL") — they land verbatim in the
  // add-entry editor rows, so the RU picker must render them readably.
  '/uL': '/мкл',
  '/µL': '/мкл',
  '/mL': '/мл',
  'K/uL': 'тыс/мкл',
  'K/µL': 'тыс/мкл',
  'U/mL{RBCs}': 'Ед/мл эритр.',
  'U/g{Hb}': 'Ед/г Hb',
  // Ratios / scores / indices
  '{ratio}': 'коэфф.',
  'ratio': 'коэфф.',
  '{score}': 'баллы',
  '{M.o.M}': 'МоМ',
  '{Index_val}': 'индекс',
  // Microbiology (matcher-anchored canonical units)
  'copies/mL': 'копий/мл',
  'copies/g': 'копий/г',
  'copies/mg': 'копий/мг',
  // Excretion / clearance / other
  'mmol/mol{creat}': 'ммоль/моль креатинина',
  'umol/mmol{creat}': 'мкмоль/ммоль креатинина',
  'ug/mg{creat}': 'мкг/мг креатинина',
  'mg/g{creat}': 'мг/г креатинина',
  'umol/g{creat}': 'мкмоль/г креатинина',
  'pg/g{creat}': 'пг/г креатинина',
  'ug/(24.h)': 'мкг/24 ч',
  'mg/(24.h)': 'мг/24 ч',
  'g/(24.h)': 'г/24 ч',
  'mL/(24.h)': 'мл/24 ч',
  'meq/L': 'мэкв/л',
  'mL/min': 'мл/мин',
  'mL/min/{1.73_m2}': 'мл/мин/1,73 м²',
  'mL/s': 'мл/с',
  'mL/dL': 'мл/дл',
  'mosm/kg': 'мосм/кг',
  // Misc physical
  's': 'с',
  'mm': 'мм',
  'mm/h': 'мм/ч',
  'Deg': '°',
  '[pH]': 'pH',
  'nmol/h/mg{protein}': 'нмоль/ч·мг белка',
}

function _normKey(unit: string): string {
  return unit.trim().replace(/\s+/g, '').replace(/µ/g, 'u').toLowerCase()
}

const _RU_BY_NORM: Record<string, string> = Object.fromEntries(
  Object.entries(UNIT_LABELS_RU).map(([k, v]) => [_normKey(k), v]),
)

/**
 * Russian display label for a canonical unit string. Unknown units pass
 * through unchanged. Non-Russian locales must not call this.
 */
export function unitLabelRu(unit: string | null | undefined): string {
  if (!unit) return ''
  return _RU_BY_NORM[_normKey(unit)] ?? unit
}
