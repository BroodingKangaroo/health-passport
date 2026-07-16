import { test, expect, type Page } from '@playwright/test'

async function uploadFile(page: Page, name: string, type: string, content: string) {
  const input = page.locator('input[type="file"]')
  await input.waitFor({ state: 'attached', timeout: 5000 })
  await input.setInputFiles({ name, mimeType: type, buffer: Buffer.from(content) })
  await page.waitForTimeout(100)
  await input.dispatchEvent('change')
}

test.describe('AddEntry - API Error', () => {
  test('shows error banner and falls back to manual entry when AI extraction fails', async ({ page }) => {
    await page.route('**/api/extract', async (route) => {
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ detail: 'E2E API unavailable' }) })
    })

    await page.goto('/add-entry')
    await uploadFile(page, 'test-fail.pdf', 'application/pdf', 'fake content')

    await expect(page.getByText('AI extraction failed')).toBeVisible({ timeout: 10000 })
    await expect(page.getByText('Switched to manual entry. Fill in the details below.')).toBeVisible()

    await page.locator('input[type="date"]').fill('2099-06-01')
    await page.getByPlaceholder('e.g. Invitro Lab').fill('E2E Error Lab')
    await page.getByPlaceholder('e.g. Dr. Ivanova').fill('Dr. Error')
    await page.getByPlaceholder('e.g. Pre-Operative Baseline').fill('E2E Error Test')

    await page.locator('button[role="combobox"]').filter({ hasText: 'Search biomarker' }).click()
    await page.getByPlaceholder('Search biomarker…').fill('Glucose')
    await page.getByRole('option', { name: /Glucose/ }).click()

    await page.locator('input[placeholder="—"]').first().fill('95')

    await page.getByText('Save to HealthPassport').click()

    await page.waitForURL('/')
    await expect(page.getByText('E2E Error Lab').first()).toBeVisible()
  })
})
