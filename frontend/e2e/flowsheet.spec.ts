import { test, expect } from '@playwright/test'

test.describe('Flowsheet', () => {
  test('displays biomarker matrix with seeded data', async ({ page }) => {
    await page.goto('/flowsheet')

    await expect(page.getByText('Lab Flowsheet (Matrix)')).toBeVisible()
    await expect(page.getByText('Complete Blood Count')).toBeVisible()
    await expect(page.getByText('Comprehensive Metabolic Panel')).toBeVisible()
    await expect(page.getByText('Lipid Panel')).toBeVisible()

    await expect(page.getByText('WBC')).toBeVisible()
    await expect(page.getByText('Hemoglobin')).toBeVisible()
    await expect(page.getByText('Glucose')).toBeVisible()
  })
})
