import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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

import { discordMigrationApi, type ImportInventory, type SourceChannel } from '@/lib/discordMigration'
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

function lazySources() {
  const dm: SourceChannel = { id: '350', name: 'Yakın arkadaş', type: 1, position: 0, message_count: 0, media_count: 0, authors: [] }
  const source = { guilds: [{ id: '100', name: 'Kaynak sunucu', roles: [], channels_loaded: false },
    { id: '101', name: 'Diğer sunucu', roles: [], channels_loaded: false }], channels: [dm], warnings: [], account: inventory.account }
  const loaded = { ...source, channels: [dm, ...inventory.channels], guilds: [{ ...source.guilds[0], channels_loaded: true,
    roles: [{ id: '800', name: 'Üyeler', color: 0, position: 1, permissions: '1', managed: false },
      { id: '801', name: 'Bot rolü', color: 0, position: 2, permissions: '8', managed: true }] }, source.guilds[1]] }
  return { source, loaded }
}

async function connectDesktop(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('tab', { name: 'Discord’dan seç' }))
  await user.click(screen.getByRole('checkbox', { name: /Kendi hesabımı kullanıyorum/ }))
  await user.type(screen.getByLabelText('Discord hesap tokeni'), 'synthetic-device-only-token')
  await user.click(screen.getByRole('button', { name: 'Bağlan ve kaynakları göster' }))
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
    const sourceWarning = 'Bir kanalın geçmişi erişim izni değiştiği için alınamadı.'
    const local = { ...inventory, id: 'local-selection', status: 'local', source_hash: 'local', warnings: [sourceWarning, sourceWarning] }
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
    expect(screen.getAllByText(sourceWarning)).toHaveLength(1)
    expect(collect).toHaveBeenCalledWith(expect.objectContaining({ excluded_author_ids: ['400'], channel_ids: ['300'] }))
    expect(discordMigrationApi.upload).toHaveBeenCalledTimes(1)
    expect(discordMigrationApi.preview).toHaveBeenCalledWith('job-1', expect.objectContaining({ excluded_author_ids: [], channel_ids: ['300'] }), expect.any(AbortSignal))
    expect(discordMigrationApi.commit).not.toHaveBeenCalled()
  })

  it('keeps inspected source and author selections after a packing limit and retries without a second scan', async () => {
    const scan = vi.fn().mockResolvedValue({ ...inventory, id: 'local-selection', status: 'local', source_hash: 'local' })
    const collect = vi.fn().mockRejectedValueOnce(new Error("Error invoking remote method 'collect': SOURCE_ARCHIVE_LIMIT"))
      .mockResolvedValueOnce(new Uint8Array([80, 75, 3, 4]))
    const connect = vi.fn().mockResolvedValue({ guilds: inventory.guilds, channels: inventory.channels, warnings: [], account: inventory.account })
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { discordMigration: {
      connect, scan, collect, cancel: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined), onProgress: () => () => undefined,
    } } })
    vi.mocked(discordMigrationApi.upload).mockResolvedValue({ ...inventory,
      authors: inventory.authors.filter(author => author.id !== '400'),
      channels: inventory.channels.map(channel => ({ ...channel, authors: [{ id: '401', count: 2 }] })) })
    const user = userEvent.setup()
    renderWizard()
    await connectDesktop(user)
    await user.click(await screen.findByRole('checkbox', { name: 'genel aktarımını seç' }))
    await user.click(screen.getByRole('button', { name: 'Seçili içeriği hazırla' }))
    await screen.findByText(/Seçili geçmiş şu anda yalnızca cihazında/)
    await user.click(screen.getByRole('tab', { name: 'Kişiler' }))
    await user.click(within(screen.getByText('Alpha').closest('label')!).getByRole('checkbox'))
    await user.click(screen.getByRole('button', { name: 'Seçimleri incele' }))
    await screen.findByText(/Hazırlanan arşiv 64 MB sınırını aşıyor/)
    expect(screen.getByRole('checkbox', { name: 'genel aktarımını seç' })).toBeChecked()
    expect(within(screen.getByText('Alpha').closest('label')!).getByRole('checkbox')).toBeChecked()
    expect(screen.getByText(/Seçili geçmiş şu anda yalnızca cihazında/)).toBeVisible()
    expect(discordMigrationApi.upload).not.toHaveBeenCalled()
    await user.click(screen.getByRole('tab', { name: 'İçerik' }))
    await user.click(screen.getByRole('checkbox', { name: /Mesaj ekleri/ }))
    await user.click(screen.getByRole('button', { name: 'Seçimleri incele' }))
    await screen.findByRole('heading', { name: 'Seçtiklerin böyle gelecek' })
    expect(collect).toHaveBeenNthCalledWith(2, expect.objectContaining({ channel_ids: ['300'], excluded_author_ids: ['400'], include_media: false }))
    expect(scan).toHaveBeenCalledTimes(1)
    expect(connect).toHaveBeenCalledTimes(1)
    expect(discordMigrationApi.upload).toHaveBeenCalledTimes(1)
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

  it('shows lazy guild names immediately and loads only the opened guild while preserving other selections', async () => {
    const { source, loaded } = lazySources()
    let completeInspection!: (value: typeof loaded) => void
    const inspectGuild = vi.fn().mockImplementation(() => new Promise<typeof loaded>(resolve => { completeInspection = resolve }))
    let progress: ((event: { phase: 'discovery'; messages: number; media: number; guild_name: string; waiting_ms: number }) => void) | undefined
    const scan = vi.fn().mockResolvedValue({ ...inventory, ...loaded, id: 'local-selection', status: 'local', source_hash: 'local' })
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { discordMigration: {
      connect: vi.fn().mockResolvedValue(source), inspectGuild, scan, collect: vi.fn(),
      cancel: vi.fn().mockResolvedValue(undefined), disconnect: vi.fn().mockResolvedValue(undefined),
      onProgress: (callback: typeof progress) => { progress = callback; return () => undefined },
    } } })
    const user = userEvent.setup()
    renderWizard()
    await connectDesktop(user)
    const open = await screen.findByRole('button', { name: 'Kaynak sunucu kanallarını göster' })
    expect(screen.getByRole('button', { name: 'Diğer sunucu kanallarını göster' })).toBeVisible()
    expect(inspectGuild).not.toHaveBeenCalled()
    expect(screen.queryByRole('checkbox', { name: 'genel aktarımını seç' })).not.toBeInTheDocument()
    await user.click(open)
    await user.click(screen.getByRole('checkbox', { name: 'Yakın arkadaş aktarımını seç' }))
    act(() => progress?.({ phase: 'discovery', messages: 0, media: 0, guild_name: 'Kaynak sunucu', waiting_ms: 5000 }))
    expect(screen.getByText(/Kaynak sunucu kanalları yükleniyor.*5 sn bekleniyor/)).toBeVisible()
    expect(screen.getByRole('button', { name: 'Seçili içeriği hazırla' })).toBeDisabled()
    await act(async () => completeInspection(loaded))
    expect(await screen.findByRole('checkbox', { name: 'genel aktarımını seç' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Yakın arkadaş aktarımını seç' })).toBeChecked()
    await user.click(screen.getByRole('checkbox', { name: 'Kaynak sunucu sunucusunu seç' }))
    await user.click(screen.getByRole('button', { name: 'Kaynak sunucu kanallarını daralt' }))
    await user.click(screen.getByRole('button', { name: 'Kaynak sunucu kanallarını göster' }))
    expect(inspectGuild).toHaveBeenCalledTimes(1)
    expect(inspectGuild).toHaveBeenCalledWith('100')
    await user.click(screen.getByRole('button', { name: 'Seçili içeriği hazırla' }))
    await waitFor(() => expect(scan).toHaveBeenCalledWith(expect.objectContaining({
      channel_ids: ['300', '350'], guild_ids: ['100'], role_ids: { '100': ['800'] },
    })))
    expect(discordMigrationApi.upload).not.toHaveBeenCalled()
  })

  it('loads and selects a lazy guild checkbox only after successful inspection and allows retry after failure', async () => {
    const { source, loaded } = lazySources()
    const inspectGuild = vi.fn().mockRejectedValueOnce(new Error('403')).mockResolvedValueOnce(loaded)
    const scan = vi.fn()
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { discordMigration: {
      connect: vi.fn().mockResolvedValue(source), inspectGuild, scan, collect: vi.fn(),
      cancel: vi.fn().mockResolvedValue(undefined), disconnect: vi.fn().mockResolvedValue(undefined), onProgress: () => () => undefined,
    } } })
    const user = userEvent.setup()
    renderWizard()
    await connectDesktop(user)
    await user.click(await screen.findByRole('checkbox', { name: 'Kaynak sunucu sunucusunu seç' }))
    await screen.findByText(/Kaynak sunucu sunucusunun kanalları alınamadı/)
    expect(screen.getByRole('checkbox', { name: 'Kaynak sunucu sunucusunu seç' })).not.toBeChecked()
    expect(screen.getByRole('button', { name: 'Seçili içeriği hazırla' })).toBeDisabled()
    expect(scan).not.toHaveBeenCalled()
    await user.click(screen.getByRole('checkbox', { name: 'Kaynak sunucu sunucusunu seç' }))
    expect(await screen.findByRole('checkbox', { name: 'genel aktarımını seç' })).toBeChecked()
    expect(inspectGuild).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('button', { name: 'Seçili içeriği hazırla' })).toBeEnabled()
  })

  it('ignores a late guild response after cancellation and never continues with an unloaded selected guild', async () => {
    const { source, loaded } = lazySources()
    let completeInspection!: (value: typeof loaded) => void
    const inspectGuild = vi.fn().mockImplementation(() => new Promise<typeof loaded>(resolve => { completeInspection = resolve }))
    const cancel = vi.fn().mockResolvedValue(undefined)
    const scan = vi.fn()
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { discordMigration: {
      connect: vi.fn().mockResolvedValue(source), inspectGuild, scan, collect: vi.fn(), cancel,
      disconnect: vi.fn().mockResolvedValue(undefined), onProgress: () => () => undefined,
    } } })
    const user = userEvent.setup()
    renderWizard()
    await connectDesktop(user)
    await user.click(await screen.findByRole('checkbox', { name: 'Kaynak sunucu sunucusunu seç' }))
    await user.click(screen.getByRole('button', { name: 'Durdur' }))
    await waitFor(() => expect(cancel).toHaveBeenCalledTimes(1))
    await act(async () => completeInspection(loaded))
    expect(screen.queryByRole('checkbox', { name: 'genel aktarımını seç' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Seçili içeriği hazırla' })).toBeDisabled()
    expect(scan).not.toHaveBeenCalled()
    expect(discordMigrationApi.upload).not.toHaveBeenCalled()
  })

  it('loads all explicitly requested lazy guilds before selecting them without reading histories or uploading', async () => {
    const { source, loaded } = lazySources()
    const allLoaded = { ...loaded, guilds: [loaded.guilds[0], { ...loaded.guilds[1], channels_loaded: true }],
      channels: [...loaded.channels, { ...inventory.channels[0], id: '301', guild_id: '101', name: 'ikinci kanal' }] }
    const inspectGuild = vi.fn().mockResolvedValueOnce(loaded).mockResolvedValueOnce(allLoaded)
    const scan = vi.fn()
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { discordMigration: {
      connect: vi.fn().mockResolvedValue(source), inspectGuild, scan, collect: vi.fn(),
      cancel: vi.fn().mockResolvedValue(undefined), disconnect: vi.fn().mockResolvedValue(undefined), onProgress: () => () => undefined,
    } } })
    const user = userEvent.setup()
    renderWizard()
    await connectDesktop(user)
    await user.click(await screen.findByRole('button', { name: 'Tümü' }))
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'ikinci kanal aktarımını seç' })).toBeChecked())
    expect(screen.getByRole('checkbox', { name: 'genel aktarımını seç' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Yakın arkadaş aktarımını seç' })).toBeChecked()
    expect(inspectGuild).toHaveBeenNthCalledWith(1, '100')
    expect(inspectGuild).toHaveBeenNthCalledWith(2, '101')
    expect(scan).not.toHaveBeenCalled()
    expect(discordMigrationApi.upload).not.toHaveBeenCalled()
  })

  it('retains prior selections and loaded metadata when all sources exceed the channel limit', async () => {
    const { source, loaded } = lazySources()
    const oversized = { ...loaded, channels: [source.channels[0], ...Array.from({ length: 3001 }, (_, index) => ({
      ...inventory.channels[0], id: String(1000 + index), name: `kanal-${index}`,
    }))] }
    const inspectGuild = vi.fn().mockResolvedValue(oversized)
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { discordMigration: {
      connect: vi.fn().mockResolvedValue(source), inspectGuild, scan: vi.fn(), collect: vi.fn(),
      cancel: vi.fn().mockResolvedValue(undefined), disconnect: vi.fn().mockResolvedValue(undefined), onProgress: () => () => undefined,
    } } })
    const user = userEvent.setup()
    renderWizard()
    await connectDesktop(user)
    await user.click(await screen.findByRole('checkbox', { name: 'Yakın arkadaş aktarımını seç' }))
    await user.click(screen.getByRole('button', { name: 'Tümü' }))
    await screen.findByText(/Tek aktarımda en fazla 3000 kanal/)
    expect(screen.getByText('1 kanal seçili')).toBeVisible()
    expect(inspectGuild).toHaveBeenCalledTimes(1)
    fireEvent.change(screen.getByRole('textbox', { name: 'Kaynaklarda ara' }), { target: { value: 'Yakın arkadaş' } })
    expect(screen.getByRole('checkbox', { name: 'Yakın arkadaş aktarımını seç' })).toBeChecked()
    fireEvent.change(screen.getByRole('textbox', { name: 'Kaynaklarda ara' }), { target: { value: '' } })
    await user.click(screen.getByRole('checkbox', { name: 'Kaynak sunucu sunucusunu seç' }))
    expect(screen.getByRole('button', { name: 'Seçili içeriği hazırla' })).toBeDisabled()
    expect(discordMigrationApi.upload).not.toHaveBeenCalled()
  }, 15_000)

  it('retains metadata but never resurrects cleared selections when bulk loading finishes', async () => {
    const { source, loaded } = lazySources()
    const allLoaded = { ...loaded, guilds: [loaded.guilds[0], { ...loaded.guilds[1], channels_loaded: true }],
      channels: [...loaded.channels, { ...inventory.channels[0], id: '301', guild_id: '101', name: 'ikinci kanal' }] }
    let completeInspection!: (value: typeof loaded) => void
    const inspectGuild = vi.fn().mockImplementationOnce(() => new Promise<typeof loaded>(resolve => { completeInspection = resolve }))
      .mockResolvedValueOnce(allLoaded)
    const scan = vi.fn()
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { discordMigration: {
      connect: vi.fn().mockResolvedValue(source), inspectGuild, scan, collect: vi.fn(),
      cancel: vi.fn().mockResolvedValue(undefined), disconnect: vi.fn().mockResolvedValue(undefined), onProgress: () => () => undefined,
    } } })
    const user = userEvent.setup()
    renderWizard()
    await connectDesktop(user)
    await user.click(await screen.findByRole('checkbox', { name: 'Yakın arkadaş aktarımını seç' }))
    await user.click(screen.getByRole('button', { name: 'Tümü' }))
    await user.click(screen.getByRole('button', { name: 'Temizle' }))
    await act(async () => completeInspection(loaded))
    await screen.findByText(/Yükleme sırasında seçimlerini değiştirdiğin için tümünü otomatik seçmedim/)
    expect(inspectGuild).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('checkbox', { name: 'genel aktarımını seç' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'ikinci kanal aktarımını seç' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Yakın arkadaş aktarımını seç' })).not.toBeChecked()
    expect(screen.getByText('0 kanal seçili')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Seçili içeriği hazırla' })).toBeDisabled()
    expect(scan).not.toHaveBeenCalled()
    expect(discordMigrationApi.upload).not.toHaveBeenCalled()
  })
})
