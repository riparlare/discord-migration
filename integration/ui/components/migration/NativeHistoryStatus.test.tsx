import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import NativeHistoryStatus from './NativeHistoryStatus'
vi.mock('./ImportedHistory', () => ({ default: () => <div>Legacy archive</div> }))

describe('normal imported conversation history', () => {
  it('suppresses duplicate archive rendering after projection and when metadata is absent', () => {
    const view = render(<NativeHistoryStatus channelId="1" />)
    expect(screen.queryByText('Legacy archive')).not.toBeInTheDocument()
    view.rerender(<NativeHistoryStatus channelId="1" channel={{ history_import: { state: 'complete', legacy_archive_visible: true } }} />)
    expect(screen.queryByText('Legacy archive')).not.toBeInTheDocument()
  })
  it('shows explicit projection state and respects the server legacy visibility switch', () => {
    const view = render(<NativeHistoryStatus channelId="1" channel={{ history_import: { state: 'projecting', legacy_archive_visible: true } }} />)
    expect(screen.getByRole('status')).toHaveTextContent('hazırlanıyor')
    expect(screen.getByText('Legacy archive')).toBeInTheDocument()
    view.rerender(<NativeHistoryStatus channelId="1" channel={{ history_import: { state: 'failed', legacy_archive_visible: false } }} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Kaynak arşiv korundu')
    expect(screen.queryByText('Legacy archive')).not.toBeInTheDocument()
  })
})
