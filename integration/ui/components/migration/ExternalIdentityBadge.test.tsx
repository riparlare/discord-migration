import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
const openProfile = vi.hoisted(() => vi.fn())
vi.mock('@/stores/uiStore', () => ({ useUiStore: (select: (value: unknown) => unknown) => select({ openUserProfile: openProfile }) }))
import ExternalIdentityBadge from './ExternalIdentityBadge'
describe('source profile provenance', () => {
  it('shows unclaimed attribution without pretending archive identity is verified', () => {
    render(<ExternalIdentityBadge identity={{ provider: 'discord', subject: '123', unclaimed: true }} />)
    expect(screen.getByText(/Hesap sahiplenilmedi/)).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
  it('opens the linked native account separately, without assigning guild membership', () => {
    render(<ExternalIdentityBadge identity={{ provider: 'discord', subject: '123', unclaimed: false, linked_user_id: '456' }} />)
    fireEvent.click(screen.getByRole('button', { name: /Doğrulanmış Riparlare/ }))
    expect(openProfile).toHaveBeenCalledWith('456', null, expect.any(Number), expect.any(Number))
  })
})
