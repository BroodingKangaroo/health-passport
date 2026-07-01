import { test, expect } from '@playwright/test'

test.describe('AddEntry - Manual Entry', () => {
  test('saves a blood test entry manually and shows it on timeline', async ({ page }) => {
    await page.goto('/add-entry')
    await page.getByText('Skip Upload & Enter Manually').click()
    await expect(page.getByText('Save to HealthPassport')).toBeVisible()

    await page.locator('input[type="date"]').fill('2099-01-15')
    await page.getByPlaceholder('e.g. Invitro Lab').fill('E2E Manual Lab')
    await page.getByPlaceholder('e.g. Dr. Ivanova').fill('Dr. Manual')
    await page.getByPlaceholder('e.g. Pre-Operative Baseline').fill('E2E Manual Blood Test')
    await page.getByPlaceholder('e.g. Fasted for 12').fill('Manual e2e test notes')

    await page.getByPlaceholder('Name').fill('Glucose')
    const placeholders = page.locator('input[placeholder="—"]')
    await placeholders.nth(0).fill('95')
    await placeholders.nth(1).fill('mg/dL')
    await placeholders.nth(2).fill('70-100')

    await page.getByText('Save to HealthPassport').click()

    await page.waitForURL('/')
    await expect(page.getByText('E2E Manual Lab').first()).toBeVisible()
    await expect(page.getByText('E2E Manual Blood Test').first()).toBeVisible()
  })

  test('saves a doctor visit entry manually', async ({ page }) => {
    await page.goto('/add-entry')
    await page.getByText('Skip Upload & Enter Manually').click()
    await expect(page.getByText('Save to HealthPassport')).toBeVisible()

    await page.locator('select').first().selectOption('doctor_visit')
    await expect(page.getByText('Primary Diagnosis')).toBeVisible()

    await page.locator('input[type="date"]').fill('2099-02-20')
    await page.getByPlaceholder('e.g. Invitro Lab').fill('E2E Manual Clinic')

    const textareas = page.locator('textarea')
    await textareas.nth(0).fill('E2E Test Diagnosis')
    await textareas.nth(1).fill('E2E Chief Complaint')
    await textareas.nth(2).fill('E2E Objective Findings')

    await page.getByText('Add Medication').click()
    await page.getByPlaceholder('Medication name').fill('E2E Drug')
    await page.getByPlaceholder('Dosage').fill('10mg')
    await page.getByPlaceholder('Instructions').fill('Once daily')

    await page.getByText('Add Recommendation').click()
    await page.getByPlaceholder('Task / recommendation').fill('E2E Recommendation')

    await page.getByText('Save to HealthPassport').click()

    await page.waitForURL('/')
    await expect(page.getByText('E2E Manual Clinic').first()).toBeVisible()
  })
})
