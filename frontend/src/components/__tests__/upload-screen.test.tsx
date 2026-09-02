import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { UploadScreen } from '../health-passport/upload-screen'
import { TestI18nProvider } from '@/test/i18n-test-provider'

const renderI18n = ((ui: React.ReactElement, options?: Parameters<typeof render>[1]) =>
  render(<TestI18nProvider>{ui}</TestI18nProvider>, options)) as typeof render

function idleProps() {
  return {
    uploadState: 'idle' as const,
    progressStage: 'ocr_scanning' as const,
    biomarkerCount: null,
    elapsedSeconds: 0,
    plannedEndSeconds: null,
    multiFileNotice: null,
    onFiles: vi.fn(),
    onStartManual: vi.fn(),
  }
}

describe('UploadScreen AI disclosure', () => {
  it('shows the AI-processing disclosure while idle', () => {
    renderI18n(<UploadScreen {...idleProps()} />)

    expect(
      screen.getByText(
        'Documents are processed by an AI service and are not stored there. You can delete or export your data at any time.',
      ),
    ).toBeInTheDocument()
  })
})
