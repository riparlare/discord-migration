import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/api/client', () => ({ axiosInstance: {} }))
vi.mock('@/lib/connectionConfig', () => ({ getApiBaseUrl: () => 'https://riparlare.test/api/v1' }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@/lib/discordMigration', async importOriginal => {
  const original = await importOriginal<typeof import('@/lib/discordMigration')>()
  return { ...original, discordMigrationApi: {
    upload: vi.fn(), list: vi.fn(), get: vi.fn(), preview: vi.fn(), commit: vi.fn(), messages: vi.fn(), media: vi.fn(), adoptUsername: vi.fn(),
  } }
})

import { discordMigrationApi, type ImportInventory } from '@/lib/discordMigration'
import DiscordImportWizard from './DiscordImportWizard'
import ImportedHistory from './ImportedHistory'

const inventory: ImportInventory = {
  id: 'job-1', status: 'ready', source_hash: 'source-hash', warnings: [],
  account: { id: '700', username: 'discord_alpha' },
  guilds: [{ id: '100', name: 'Kaynak sunucu', roles: [] }],
  channels: [{ id: '300', guild_id: '100', name: 'genel', type: 0, position: 0, message_count: 5, media_count: 0,
    authors: [{ id: '400', count: 3 }, { id: '401', count: 2 }] }],
  authors: [{ id: '400', name: 'Alpha', message_count: 3, unclaimed: true }, { id: '401', name: 'Beta', message_count: 2, unclaimed: true }],
}

function renderWizard() {
  return render(<MemoryRouter><DiscordImportWizard /></MemoryRouter>)
}

async function loadArchive() {
  fireEvent.change(screen.getByLabelText('Discord ZIP arşivi seç'), {
    target: { files: [new File(['synthetic'], 'source.zip', { type: 'application/zip' })] },
  })
  await screen.findByRole('checkbox', { name: 'genel aktarımını seç' })
}

describe('selective import UI', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: undefined })
    vi.mocked(discordMigrationApi.list).mockResolvedValue([])
    vi.mocked(discordMigrationApi.upload).mockResolvedValue(inventory)
    vi.mocked(discordMigrationApi.preview).mockResolvedValue({ selection_hash: 'server-preview', counts: { channels: 1, messages: 2, media: 0, excluded_messages: 3 }, warnings: [] })
    vi.mocked(discordMigrationApi.commit).mockResolvedValue({ ...inventory, status: 'committed', destinations: [{ source_id: '300', name: 'genel', guild_id: '500', channel_id: '600' }] })
    vi.mocked(discordMigrationApi.adoptUsername).mockResolvedValue('updated')
  })

  it('requires server preview and explicit confirmation and sends author exclusions to commit', async () => {
    const user = userEvent.setup()
    renderWizard()
    await loadArchive()
    await user.click(screen.getByRole('checkbox', { name: 'genel aktarımını seç' }))
    await user.click(screen.getByRole('tab', { name: 'Kişiler' }))
    const authorLabel = screen.getByText('Alpha').closest('label')!
    await user.click(within(authorLabel).getByRole('checkbox'))
    await user.click(screen.getByRole('button', { name: 'Seçimleri incele' }))
    await screen.findByRole('heading', { name: 'Seçtiklerin böyle gelecek' })
    const commit = screen.getByRole('button', { name: 'Riparlare’ye aktar' })
    expect(commit).toBeDisabled()
    expect(discordMigrationApi.commit).not.toHaveBeenCalled()
    await user.click(screen.getByRole('checkbox', { name: /Seçimleri ve eksikleri inceledim/ }))
    await user.click(commit)
    await screen.findByRole('heading', { name: 'Seçtiklerin Riparlare’de' })
    expect(discordMigrationApi.preview).toHaveBeenCalledWith('job-1', expect.objectContaining({ channel_ids: ['300'], excluded_author_ids: ['400'] }))
    expect(discordMigrationApi.commit).toHaveBeenCalledWith('job-1', expect.objectContaining({ channel_ids: ['300'], excluded_author_ids: ['400'] }), 'server-preview')
    expect(screen.getByRole('link', { name: 'genel' })).toHaveAttribute('href', '/app/500/600')
    expect(discordMigrationApi.adoptUsername).not.toHaveBeenCalled()
  })

  it('invalidates confirmation after changed channel content choices', async () => {
    const user = userEvent.setup()
    renderWizard()
    await loadArchive()
    await user.click(screen.getByRole('checkbox', { name: 'genel aktarımını seç' }))
    await user.click(screen.getByRole('button', { name: 'Seçimleri incele' }))
    await user.click(await screen.findByRole('checkbox', { name: /Seçimleri ve eksikleri inceledim/ }))
    await user.click(screen.getByRole('button', { name: 'Seçime dön' }))
    await user.click(screen.getByRole('tab', { name: 'İçerik' }))
    await user.click(screen.getByRole('checkbox', { name: /Mesaj geçmişi/ }))
    await user.click(screen.getByRole('button', { name: 'Seçimleri incele' }))
    expect(await screen.findByRole('button', { name: 'Riparlare’ye aktar' })).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: /Seçimleri ve eksikleri inceledim/ })).not.toBeChecked()
    expect(discordMigrationApi.preview).toHaveBeenLastCalledWith('job-1', expect.objectContaining({ include_messages: false, include_media: false }))
  })

  it('does not request arbitrary imported attachment URLs with native authentication', async () => {
    vi.mocked(discordMigrationApi.messages).mockResolvedValue({ has_more: false, messages: [{
      id: '900', channel_id: '600', timestamp: '2026-10-27T00:00:00Z', content: 'synthetic',
      author: { id: '400', name: 'Alpha', unclaimed: true }, provenance: 'discord_import',
      attachments: [{ id: '901', filename: 'private.gif', url: 'https://foreign.test/file.gif' }],
    }] })
    const user = userEvent.setup()
    render(<ImportedHistory channelId="600" />)
    await user.click(await screen.findByRole('button', { name: /Discord’dan aktarılan geçmiş/ }))
    expect(screen.getByRole('button', { name: 'private.gif' })).toBeDisabled()
    await waitFor(() => expect(discordMigrationApi.media).not.toHaveBeenCalled())
  })

  it.each(['committed', 'queued'])('offers the source username as opt-in and keeps the accepted %s import when that name is taken', async status => {
    vi.mocked(discordMigrationApi.adoptUsername).mockResolvedValue('taken')
    const accepted = { ...inventory, status, destinations: [{ source_id: '300', name: 'genel', guild_id: '500', channel_id: '600' }] }
    vi.mocked(discordMigrationApi.commit).mockResolvedValue(accepted)
    vi.mocked(discordMigrationApi.get).mockResolvedValue(accepted)
    const user = userEvent.setup()
    renderWizard()
    await loadArchive()
    await user.click(screen.getByRole('checkbox', { name: 'genel aktarımını seç' }))
    await user.click(screen.getByRole('button', { name: 'Seçimleri incele' }))
    const usernameChoice = await screen.findByRole('checkbox', { name: /Discord’daki @discord_alpha kullanıcı adını/ })
    expect(usernameChoice).not.toBeChecked()
    await user.click(usernameChoice)
    await user.click(screen.getByRole('checkbox', { name: /Seçimleri ve eksikleri inceledim/ }))
    await user.click(screen.getByRole('button', { name: 'Riparlare’ye aktar' }))
    await screen.findByRole('heading', { name: status === 'committed' ? 'Seçtiklerin Riparlare’de' : 'İçerik aktarılıyor' })
    expect(await screen.findByText(/Bu kullanıcı adı Riparlare’de başka biri tarafından kullanılıyor/)).toBeVisible()
    expect(discordMigrationApi.adoptUsername).toHaveBeenCalledWith('discord_alpha')
    expect(discordMigrationApi.commit).toHaveBeenCalledTimes(1)
  })

  it('never asks the desktop bridge to verify on the server without separate opt-in', async () => {
    const verifyAccount = vi.fn()
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { discordMigration: {
      connect: vi.fn().mockResolvedValue({ guilds: inventory.guilds, channels: inventory.channels, warnings: [], account: inventory.account }),
      scan: vi.fn(), collect: vi.fn(), cancel: vi.fn().mockResolvedValue(undefined), disconnect: vi.fn().mockResolvedValue(undefined),
      onProgress: () => () => undefined, verifyAccount,
    } } })
    const user = userEvent.setup()
    renderWizard()
    await user.click(screen.getByRole('tab', { name: 'Discord’dan seç' }))
    const verifyChoice = screen.getByRole('checkbox', { name: /Discord hesabımı bağla/ })
    expect(verifyChoice).not.toBeChecked()
    await user.click(screen.getByRole('checkbox', { name: /Kendi hesabımı kullanıyorum/ }))
    await user.type(screen.getByLabelText('Discord hesap tokeni'), 'synthetic-device-only-token')
    await user.click(screen.getByRole('button', { name: 'Bağlan ve kaynakları göster' }))
    await screen.findByRole('checkbox', { name: 'genel aktarımını seç' })
    expect(verifyAccount).not.toHaveBeenCalled()
    expect(screen.queryByDisplayValue('synthetic-device-only-token')).not.toBeInTheDocument()
  })

  it('keeps detailed source filtering on-device and uploads only after passing exclusions to collect', async () => {
    const local = { ...inventory, id: 'local-selection', status: 'local', source_hash: 'local' }
    const scan = vi.fn().mockResolvedValue(local)
    const collect = vi.fn().mockResolvedValue(new Uint8Array([80, 75, 3, 4]))
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { discordMigration: {
      connect: vi.fn().mockResolvedValue({ guilds: inventory.guilds, channels: inventory.channels, warnings: [], account: inventory.account }),
      scan, collect, cancel: vi.fn().mockResolvedValue(undefined), disconnect: vi.fn().mockResolvedValue(undefined),
      onProgress: () => () => undefined,
    } } })
    const filtered = { ...inventory, authors: inventory.authors.filter(author => author.id !== '400'),
      channels: inventory.channels.map(channel => ({ ...channel, message_count: 2, authors: [{ id: '401', count: 2 }] })) }
    vi.mocked(discordMigrationApi.upload).mockResolvedValue(filtered)
    const user = userEvent.setup()
    renderWizard()
    await user.click(screen.getByRole('tab', { name: 'Discord’dan seç' }))
    await user.click(screen.getByRole('checkbox', { name: /Kendi hesabımı kullanıyorum/ }))
    await user.type(screen.getByLabelText('Discord hesap tokeni'), 'synthetic-device-only-token')
    await user.click(screen.getByRole('button', { name: 'Bağlan ve kaynakları göster' }))
    await user.click(await screen.findByRole('checkbox', { name: 'genel aktarımını seç' }))
    await user.click(screen.getByRole('button', { name: 'Seçili içeriği hazırla' }))
    await screen.findByText(/Seçili geçmiş şu anda yalnızca cihazında/)
    expect(scan).toHaveBeenCalledWith(expect.objectContaining({ channel_ids: ['300'] }))
    expect(collect).not.toHaveBeenCalled()
    expect(discordMigrationApi.upload).not.toHaveBeenCalled()
    await user.click(screen.getByRole('tab', { name: 'Kişiler' }))
    await user.click(within(screen.getByText('Alpha').closest('label')!).getByRole('checkbox'))
    await user.click(screen.getByRole('button', { name: 'Seçimleri incele' }))
    await screen.findByRole('heading', { name: 'Seçtiklerin böyle gelecek' })
    expect(collect).toHaveBeenCalledWith(expect.objectContaining({ excluded_author_ids: ['400'], channel_ids: ['300'] }))
    expect(discordMigrationApi.upload).toHaveBeenCalledTimes(1)
    expect(discordMigrationApi.preview).toHaveBeenCalledWith('job-1', expect.objectContaining({ excluded_author_ids: [], channel_ids: ['300'] }), expect.any(AbortSignal))
    expect(discordMigrationApi.commit).not.toHaveBeenCalled()
  })

  it.each(['committed', 'importing'])('opens the existing %s job after duplicate desktop upload without preview or another commit', async status => {
    const existing = { ...inventory, id: 'existing-job', status,
      progress: { stage: 'messages', completed: 2, total: 5 },
      destinations: [{ source_id: '300', name: 'genel', guild_id: '500', channel_id: '600' }] }
    vi.mocked(discordMigrationApi.upload).mockResolvedValue(existing)
    vi.mocked(discordMigrationApi.get).mockResolvedValue(existing)
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { discordMigration: {
      connect: vi.fn().mockResolvedValue({ guilds: inventory.guilds, channels: inventory.channels, warnings: [], account: inventory.account }),
      scan: vi.fn().mockResolvedValue({ ...inventory, id: 'local-selection', status: 'local', source_hash: 'local' }),
      collect: vi.fn().mockResolvedValue(new Uint8Array([80, 75, 3, 4])),
      cancel: vi.fn().mockResolvedValue(undefined), disconnect: vi.fn().mockResolvedValue(undefined),
      onProgress: () => () => undefined,
    } } })
    const user = userEvent.setup()
    renderWizard()
    await user.click(screen.getByRole('tab', { name: 'Discord’dan seç' }))
    await user.click(screen.getByRole('checkbox', { name: /Kendi hesabımı kullanıyorum/ }))
    await user.type(screen.getByLabelText('Discord hesap tokeni'), 'synthetic-device-only-token')
    await user.click(screen.getByRole('button', { name: 'Bağlan ve kaynakları göster' }))
    await user.click(await screen.findByRole('checkbox', { name: 'genel aktarımını seç' }))
    await user.click(screen.getByRole('button', { name: 'Seçili içeriği hazırla' }))
    await screen.findByText(/Seçili geçmiş şu anda yalnızca cihazında/)
    await user.click(screen.getByRole('button', { name: 'Seçimleri incele' }))
    await screen.findByRole('heading', { name: status === 'committed' ? 'Seçtiklerin Riparlare’de' : 'İçerik aktarılıyor' })
    expect(screen.getByRole('link', { name: 'genel' })).toHaveAttribute('href', '/app/500/600')
    expect(discordMigrationApi.preview).not.toHaveBeenCalled()
    expect(discordMigrationApi.commit).not.toHaveBeenCalled()
    expect(discordMigrationApi.adoptUsername).not.toHaveBeenCalled()
    expect(discordMigrationApi.upload).toHaveBeenCalledTimes(1)
  })
})
