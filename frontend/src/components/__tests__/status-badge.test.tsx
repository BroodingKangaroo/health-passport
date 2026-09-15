import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'

import { StatusBadge } from '../shared/StatusBadge'
import { TestI18nProvider } from '@/test/i18n-test-provider'

describe('StatusBadge', () => {
  it('renders the unknown status ("") neutrally, never as abnormal', () => {
    render(
      <TestI18nProvider>
        <StatusBadge status="" />
      </TestI18nProvider>,
    )

    expect(screen.getByText('Unknown')).toBeInTheDocument()
    expect(screen.queryByText('Abnormal')).toBeNull()
  })

  it('still renders abnormal for abnormal', () => {
    render(
      <TestI18nProvider>
        <StatusBadge status="abnormal" />
      </TestI18nProvider>,
    )

    expect(screen.getByText('Abnormal')).toBeInTheDocument()
  })
})
