/**
 * Pairwise correlation statistics for the "Insights & Correlation" view.
 * Pure, dependency-free functions so the math is unit-testable.
 */

export interface PairStats {
  n: number
  r: number
  p: number
}

/**
 * Pearson correlation coefficient between two equally-sized series,
 * paired by index. Returns null when fewer than 2 paired points exist
 * or either series has zero variance.
 */
export function pearson(x: number[], y: number[]): number | null {
  if (x.length !== y.length || x.length < 2) return null
  const n = x.length
  let sumX = 0
  let sumY = 0
  let sumXY = 0
  let sumX2 = 0
  let sumY2 = 0
  for (let i = 0; i < n; i++) {
    sumX += x[i]
    sumY += y[i]
    sumXY += x[i] * y[i]
    sumX2 += x[i] * x[i]
    sumY2 += y[i] * y[i]
  }
  const num = n * sumXY - sumX * sumY
  const den = Math.sqrt(
    (n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY),
  )
  if (den === 0 || !Number.isFinite(num)) return null
  // Floating point can push a perfect correlation past ±1 (e.g. 1.0000000000000002);
  // clamp so downstream t/p computations stay finite.
  return Math.max(-1, Math.min(1, num / den))
}

/** Two-sided p-value for the correlation r over n paired points (t-test, n-2 df). */
export function correlationPValue(r: number, n: number): number {
  if (n < 3) return NaN
  const df = n - 2
  const t = r * Math.sqrt(df / (1 - r * r))
  return 2 * _tcdf(-Math.abs(t), df)
}

/**
 * Pairwise correlation stats for multiple series of normalized values.
 * Series are aligned by index (each index = one shared sample date).
 * Returns a map keyed by the sorted pair string "a|b" containing only
 * pairs with at least 2 co-present points.
 */
export function pairwiseCorrelations(
  series: Record<string, Array<number | null>>,
): Record<string, PairStats> {
  const keys = Object.keys(series).sort()
  const result: Record<string, PairStats> = {}
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const a = series[keys[i]]
      const b = series[keys[j]]
      const xs: number[] = []
      const ys: number[] = []
      const n = Math.min(a.length, b.length)
      for (let k = 0; k < n; k++) {
        const av = a[k]
        const bv = b[k]
        if (av == null || bv == null) continue
        xs.push(av)
        ys.push(bv)
      }
      if (xs.length < 2) continue
      const r = pearson(xs, ys)
      if (r == null) continue
      const pairKey = `${keys[i]}|${keys[j]}`
      result[pairKey] = { n: xs.length, r, p: correlationPValue(r, xs.length) }
    }
  }
  return result
}

/**
 * Incomplete regularized beta (continued-fraction variant) for x in [0,1]
 * with positive a, b — enough precision for t-distribution tail areas.
 */
function _betai(a: number, b: number, x: number): number {
  if (x <= 0) return 0
  if (x >= 1) return 1
  const ln = _lnBeta(a, b) + a * Math.log(x) + b * Math.log(1 - x)
  if (x < (a + 1) / (a + b + 2)) return (Math.exp(ln) * _betacf(a, b, x)) / a
  return 1 - (Math.exp(ln) * _betacf(b, a, 1 - x)) / b
}

function _lnBeta(a: number, b: number): number {
  return _logGamma(a + b) - _logGamma(a) - _logGamma(b)
}

/** Lanczos approximation of ln(Gamma(z)) for z > 0. */
function _logGamma(z: number): number {
  const g = 7
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ]
  if (z < 0.5) {
    return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * z)) - _logGamma(1 - z)
  }
  z -= 1
  let x = c[0]
  for (let i = 1; i < g + 2; i++) x += c[i] / (z + i)
  const t = z + g + 0.5
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x)
}

/** Continued-fraction evaluation of the incomplete beta function. */
function _betacf(a: number, b: number, x: number): number {
  const MAXITER = 200
  const EPS = 3e-14
  const FPMIN = 1e-300
  const qab = a + b
  const qap = a + 1
  const qam = a - 1
  let c = 1
  let d = 1 - (qab * x) / qap
  if (Math.abs(d) < FPMIN) d = FPMIN
  d = 1 / d
  let h = d
  for (let m = 1; m <= MAXITER; m++) {
    const m2 = 2 * m
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2))
    d = 1 + aa * d
    if (Math.abs(d) < FPMIN) d = FPMIN
    c = 1 + aa / c
    if (Math.abs(c) < FPMIN) c = FPMIN
    d = 1 / d
    h *= d * c
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2))
    d = 1 + aa * d
    if (Math.abs(d) < FPMIN) d = FPMIN
    c = 1 + aa / c
    if (Math.abs(c) < FPMIN) c = FPMIN
    d = 1 / d
    const del = d * c
    h *= del
    if (Math.abs(del - 1) < EPS) break
  }
  return h
}

/** Student t CDF via incomplete beta: P(T <= t) for t <= 0, df > 0. */
function _tcdf(t: number, df: number): number {
  const x = df / (df + t * t)
  return 0.5 * _betai(df / 2, 0.5, x)
}
