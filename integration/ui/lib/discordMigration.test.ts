import { describe, expect, it, vi } from 'vitest'

vi.mock('@/api/client', () => ({ axiosInstance: {} }))
vi.mock('@/lib/connectionConfig', () => ({ getApiBaseUrl: () => 'https://riparlare.test/api/v1' }))

import { canonicalSelection, channelSubtree, emptySelection, normalizeInventory, ownedImportMediaUrl, selectionDateError, selectionFingerprint, toggleChannels, type ImportInventory } from './discordMigration'

const inventory: ImportInventory = {
  id: 'job', status: 'ready', source_hash: 'hash', warnings: [],
  guilds: [{ id: '100', name: 'Sunucu', roles: [{ id: '200', name: 'Üye', permissions: '1152921504606846977', position: 1, color: 0, managed: false }] }],
  channels: [
    { id: '300', guild_id: '100', name: 'Kategori', type: 4, position: 0, message_count: 0, media_count: 0, authors: [] },
    { id: '301', guild_id: '100', parent_id: '300', name: 'Yazı', type: 0, position: 1, message_count: 3, media_count: 1, authors: [{ id: '400', count: 2 }, { id: '401', count: 1 }] },
    { id: '302', guild_id: '100', parent_id: '300', name: 'Ses', type: 2, position: 2, message_count: 2, media_count: 1, authors: [{ id: '400', count: 2 }] },
    { id: '303', name: 'Özel', type: 1, position: 0, message_count: 2, media_count: 0, authors: [{ id: '400', count: 2 }] },
    { id: '304', name: 'Grup', type: 3, position: 0, message_count: 2, media_count: 0, authors: [{ id: '401', count: 2 }] },
  ],
  authors: [{ id: '400', name: 'A', message_count: 6, unclaimed: true }, { id: '401', name: 'B', message_count: 3, unclaimed: true }],
}

describe('Discord import selection boundaries', () => {
  it('does not silently select private or group histories on initial upload', () => {
    const selection = emptySelection(inventory)
    expect(selection.channel_ids).toEqual([])
    expect(selection.include_dms).toBe(false)
    expect(selection.include_groups).toBe(false)
    expect(inventory.guilds[0].roles[0].permissions).toBe('1152921504606846977')
  })

  it('removes the entire category subtree and never reenables hidden source kinds in requests', () => {
    let selection = toggleChannels(emptySelection(inventory), inventory, ['300', '303', '304'], true)
    expect(selection.channel_ids).toEqual(expect.arrayContaining(['300', '301', '302', '303', '304']))
    selection = toggleChannels(selection, inventory, ['300'], false)
    selection.include_dms = false
    selection.include_groups = false
    expect(canonicalSelection(selection, inventory).channel_ids).toEqual([])
  })

  it('keeps global/per-channel author exclusion scopes distinct and rejects stale preview fingerprints', () => {
    const selection = { ...emptySelection(inventory), channel_ids: ['301', '302'], excluded_author_ids: ['400'], channel_excluded_author_ids: { '301': ['401'], '303': ['401'] } }
    const canonical = canonicalSelection(selection, inventory)
    expect(canonical.excluded_author_ids).toEqual(['400'])
    expect(canonical.channel_excluded_author_ids).toEqual({ '301': ['401'] })
    expect(selectionFingerprint(selection, inventory)).not.toBe(selectionFingerprint({ ...selection, channel_excluded_author_ids: { '302': ['401'] } }, inventory))
  })

  it('bounds cyclic source trees and includes exact source IDs without numeric coercion', () => {
    const cyclic = [{ ...inventory.channels[0], id: '999999999999999999', parent_id: '999999999999999998' }, { ...inventory.channels[1], id: '999999999999999998', parent_id: '999999999999999999' }]
    expect(channelSubtree(cyclic, ['999999999999999999'])).toHaveLength(2)
  })

  it('strips media when messages are disabled and catches inverted date bounds', () => {
    const selection = { ...emptySelection(inventory), include_messages: false, after: '2026-10-27T00:00:00Z', before: '2026-10-26T00:00:00Z' }
    expect(canonicalSelection(selection, inventory).include_media).toBe(false)
    expect(canonicalSelection(selection, inventory).media_types).toEqual([])
    expect(selectionDateError(selection)).toBeTruthy()
    expect(selectionDateError({ ...selection, before: '2026-10-28T00:00:00Z' })).toBeNull()
  })

  it('never forwards native credentials to foreign or archive-controlled media URLs', () => {
    expect(ownedImportMediaUrl('https://evil.test/api/v1/discord-imports/job/media/1/2/3')).toBeNull()
    expect(ownedImportMediaUrl('https://riparlare.test/api/v1/discord-imports/job/media/1/2/3?token=x')).toBeNull()
    expect(ownedImportMediaUrl('https://riparlare.test/api/v1/discord-imports/job/media/1/2/3/../../../../user/me')).toBeNull()
    expect(ownedImportMediaUrl('https://riparlare.test/api/v1/discord-imports/job/media/1/2/3')).toBe('https://riparlare.test/api/v1/discord-imports/job/media/1/2/3')
    expect(ownedImportMediaUrl('https://riparlare.test/api/v1/discord-imports/job/media/1/2/index-0')).toBe('https://riparlare.test/api/v1/discord-imports/job/media/1/2/index-0')
  })

  it('adapts persisted backend processed/state progress without displaying zero completed work', () => {
    const normalized = normalizeInventory({ ...inventory, progress: { state: 'messages', processed: 7, total: 10 } })
    expect(normalized.progress).toEqual(expect.objectContaining({ stage: 'messages', completed: 7, total: 10 }))
  })

  it('opens protected imported media from the packaged file origin without allowing foreign URLs', () => {
    vi.stubGlobal('window', { location: { origin: 'null', href: 'file:///Riparlare/.vite/renderer/main_window/index.html' } })
    try {
      expect(ownedImportMediaUrl('/api/v1/discord-imports/job/media/1/2/3')).toBe('https://riparlare.test/api/v1/discord-imports/job/media/1/2/3')
      expect(ownedImportMediaUrl('https://evil.test/api/v1/discord-imports/job/media/1/2/3')).toBeNull()
    } finally { vi.unstubAllGlobals() }
  })

  it('keeps voice channel structure selected without enabling its text history', () => {
    const selection = toggleChannels({ ...emptySelection(inventory), include_voice_text: false }, inventory, ['302'], true)
    const request = canonicalSelection(selection, inventory)
    expect(request.channel_ids).toEqual(['302'])
    expect(request.include_voice_text).toBe(false)
  })
})
