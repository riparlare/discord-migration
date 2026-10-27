import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DtoAttachment } from '@/types'
import { useNativeImportAttachments } from './useNativeImportAttachments'
const get = vi.hoisted(() => vi.fn())
vi.mock('@/api/client', () => ({ axiosInstance: { get } }))
vi.mock('@/lib/connectionConfig', () => ({ getApiBaseUrl: () => 'https://riparlare.test/api/v1' }))
function Probe({ attachments }: { attachments: DtoAttachment[] }) {
  const result = useNativeImportAttachments(attachments)
  return <div><span data-testid="ready">{result.attachments.map(a => a.url).join(',')}</span><span data-testid="missing">{result.missing.length}</span><span data-testid="errors">{result.errors.length}</span></div>
}
describe('protected native attachments', () => {
  afterEach(() => { get.mockReset(); vi.unstubAllGlobals() })
  it('fetches owned ready bytes with auth client, reuses unchanged DTOs and releases object URLs', async () => {
    const create = vi.fn(() => 'blob:owned-media')
    const revoke = vi.fn()
    vi.stubGlobal('URL', class extends URL { static createObjectURL = create; static revokeObjectURL = revoke })
    get.mockResolvedValue({ data: new Blob(['image'], { type: 'image/png' }) })
    const attachment: DtoAttachment = { filename: 'p.png', url: '/api/v1/discord-imports/channels/1/attachments/2', import_status: 'ready' }
    const view = render(<Probe attachments={[attachment]} />)
    await waitFor(() => expect(screen.getByTestId('ready')).toHaveTextContent('blob:owned-media'))
    view.rerender(<Probe attachments={[{ ...attachment }]} />)
    expect(get).toHaveBeenCalledTimes(1)
    expect(get.mock.calls[0][0]).toBe('https://riparlare.test/api/v1/discord-imports/channels/1/attachments/2')
    expect(get.mock.calls[0][1]).toMatchObject({ responseType: 'blob' })
    view.unmount()
    expect(revoke).toHaveBeenCalledWith('blob:owned-media')
  })
  it('never sends credentials to archive URLs or fetches missing originals', async () => {
    render(<Probe attachments={[
      { url: 'https://attacker.test/photo.png', import_status: 'ready' },
      { filename: 'absent.mp4', import_status: 'source_media_unavailable' },
    ]} />)
    await waitFor(() => expect(screen.getByTestId('errors')).toHaveTextContent('1'))
    expect(screen.getByTestId('missing')).toHaveTextContent('1')
    expect(get).not.toHaveBeenCalled()
  })
})
