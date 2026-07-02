import { test, expect } from '@playwright/test'

test.describe('Timeline', () => {
  test('displays seeded events in the history list', async ({ page }) => {
    await page.goto('/')

    await expect(page.getByText('History')).toBeVisible()
    await expect(page.getByText('Comprehensive Blood Panel')).toBeVisible()
    await expect(page.getByText('Cardiology Follow-up')).toBeVisible()
    await expect(page.getByText('Orthopedic Consultation')).toBeVisible()
    await expect(page.getByText('Skin Biopsy')).toBeVisible()
  })

  test('shows blood test details when a blood test event is clicked', async ({ page }) => {
    await page.goto('/')

    await page.getByText('Pre-Operative Baseline').click()

    await expect(page.getByRole('button', { name: 'Test Results' })).toBeVisible()
    await expect(page.getByText('Hemoglobin').first()).toBeVisible()
  })

  test('shows doctor visit details when a visit event is clicked', async ({ page }) => {
    await page.goto('/')

    await page.getByText('Cardiology Follow-up').click()

    await expect(page.getByText('Mild Sinus Tachycardia')).toBeVisible()
    await expect(page.getByText('Metoprolol Succinate')).toBeVisible()
  })
})
