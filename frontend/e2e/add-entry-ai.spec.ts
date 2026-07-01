import { test, expect } from '@playwright/test'

async function uploadFile(page, name: string, type: string, content: string) {
  const input = page.locator('input[type="file"]')
  await input.waitFor({ state: 'attached', timeout: 5000 })
  await input.setInputFiles({ name, mimeType: type, buffer: Buffer.from(content) })
  await page.waitForTimeout(100)
  await input.dispatchEvent('change')
}

test.describe.configure({ mode: 'serial' })
test.describe('AddEntry - AI Extraction', () => {
  test('pre-fills blood test form from AI extraction', async ({ page }) => {
    await page.route('**/api/extract', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          entry_type: 'blood_test',
          date: '2099-03-15',
          clinic: 'E2E AI Lab',
          provider: 'Dr. AI',
          title: 'E2E AI Blood Test',
          notes: 'E2E AI extraction notes',
          biomarkers: [
            { name: 'Hemoglobin', value: '145', unit: 'g/L', range: '130-170', category: 'Complete Blood Count' },
            { name: 'WBC', value: '7.2', unit: 'K/µL', range: '4.0-11.0', category: 'Complete Blood Count' },
          ],
          visit_data: null,
          imaging_data: null,
        }),
      })
    })

    await page.goto('/add-entry')
    await uploadFile(page, 'test-lab.pdf', 'application/pdf', 'fake pdf content')

    await expect(page.locator('input[type="date"]')).toHaveValue('2099-03-15', { timeout: 10000 })
    await expect(page.locator('input[value="E2E AI Lab"]')).toBeVisible()
    await expect(page.locator('input[value="Dr. AI"]')).toBeVisible()
    await expect(page.locator('input[value="E2E AI Blood Test"]')).toBeVisible()
    await expect(page.getByPlaceholder('e.g. Fasted for 12')).toHaveValue('E2E AI extraction notes')
    await expect(page.locator('input[value="Hemoglobin"]')).toBeVisible()
    await expect(page.locator('input[value="145"]')).toBeVisible()
    await expect(page.locator('input[value="WBC"]')).toBeVisible()

    await page.getByText('Save to HealthPassport').click()
    await page.waitForURL('/')
    await expect(page.getByText('E2E AI Lab').first()).toBeVisible()
  })

  test('pre-fills doctor visit form from AI extraction', async ({ page }) => {
    await page.route('**/api/extract', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          entry_type: 'doctor_visit',
          date: '2099-04-10',
          clinic: 'E2E AI Clinic',
          provider: 'Dr. AI Visit',
          title: null,
          notes: null,
          biomarkers: null,
          visit_data: {
            diagnosis: 'E2E AI Diagnosis',
            chief_complaint: 'E2E Chief Complaint',
            objective_findings: 'E2E Objective Findings',
            prescriptions: [{ name: 'E2E AI Drug', dosage: '10mg', instructions: 'Once daily' }],
            recommendations: ['E2E AI Recommendation'],
          },
          imaging_data: null,
        }),
      })
    })

    await page.goto('/add-entry')
    await uploadFile(page, 'test-visit.pdf', 'application/pdf', 'fake visit content')

    await expect(page.getByPlaceholder('e.g., Mild Sinus Tachycardia')).toHaveValue('E2E AI Diagnosis', { timeout: 10000 })
    await expect(page.getByPlaceholder('Patient reports occasional palpitations')).toHaveValue('E2E Chief Complaint')
    await expect(page.getByPlaceholder('Heart rhythm is regular. No murmurs')).toHaveValue('E2E Objective Findings')
    await expect(page.locator('input[value="E2E AI Drug"]')).toBeVisible()
    await expect(page.locator('input[value="10mg"]')).toBeVisible()
    await expect(page.locator('input[value="Once daily"]')).toBeVisible()
    await expect(page.locator('input[value="E2E AI Recommendation"]')).toBeVisible()

    await page.getByText('Save to HealthPassport').click()
    await page.waitForURL('/')
    await expect(page.getByText('E2E AI Clinic').first()).toBeVisible()
  })

  test('pre-fills imaging form from AI extraction', async ({ page }) => {
    await page.route('**/api/extract', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          entry_type: 'imaging',
          date: '2099-05-20',
          clinic: 'E2E AI Rad Center',
          provider: 'Dr. AI Rad',
          title: null,
          notes: null,
          biomarkers: null,
          visit_data: null,
          imaging_data: {
            modality: 'MRI',
            findings: 'E2E AI imaging findings',
            conclusion: 'E2E AI imaging conclusion',
          },
        }),
      })
    })

    await page.goto('/add-entry')
    await uploadFile(page, 'test-mri.pdf', 'application/pdf', 'fake mri content')

    await expect(page.locator('select').last()).toHaveValue('MRI', { timeout: 10000 })
    await expect(page.getByPlaceholder('Describe the imaging findings')).toHaveValue('E2E AI imaging findings')
    await expect(page.getByPlaceholder('Summary and clinical impression')).toHaveValue('E2E AI imaging conclusion')

    await page.getByText('Save to HealthPassport').click()
    await page.waitForURL('/')
    await expect(page.getByText('E2E AI Rad Center').first()).toBeVisible()
  })
})
