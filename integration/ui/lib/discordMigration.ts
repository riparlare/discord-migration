import { axiosInstance } from '@/api/client'
import { getApiBaseUrl } from '@/lib/connectionConfig'
import axios from 'axios'

export interface DiscordSourceAccount { id: string; username: string; display_name?: string }
export type UsernameAdoption = 'updated' | 'taken' | 'invalid' | 'failed'

export interface SourceRole {
  id: string
  name: string
  color: number
  position: number
  permissions: string
  managed: boolean
}

export interface SourceGuild { id: string; name: string; roles: SourceRole[]; channels_loaded?: boolean }
export interface SourceAuthor { id: string; name: string; display_name?: string; message_count: number; unclaimed: boolean }
export interface SourceChannel {
  id: string
  guild_id?: string
  parent_id?: string
  name: string
  type: number
  position: number
  message_count: number
  authors: { id: string; count: number }[]
  media_count: number
}

export interface ImportDestination { source_id: string; channel_id?: string; guild_id?: string; name: string }
export interface ImportInventory {
  id: string
  status: string
  source_hash: string
  guilds: SourceGuild[]
  channels: SourceChannel[]
  authors: SourceAuthor[]
  warnings: string[]
  destinations?: ImportDestination[]
  selection?: ImportSelection
  progress?: { completed?: number; total?: number; stage?: string; state?: string; processed?: number }
  error?: string
  /** Untrusted source metadata: useful for an optional name offer, never identity proof. */
  account?: DiscordSourceAccount
}

export type MediaKind = 'image' | 'video' | 'audio' | 'file'
export interface ImportSelection {
  channel_ids: string[]
  excluded_author_ids: string[]
  channel_excluded_author_ids: Record<string, string[]>
  guild_ids: string[]
  role_ids: Record<string, string[]>
  include_messages: boolean
  include_media: boolean
  media_types: MediaKind[]
  include_roles: boolean
  include_permissions: boolean
  include_voice_text: boolean
  include_dms: boolean
  include_groups: boolean
  after?: string
  before?: string
}

export interface ImportPreview {
  selection_hash: string
  counts: { channels: number; messages: number; media: number; excluded_messages: number }
  warnings: string[]
}

export interface ImportedMessage {
  id: string
  channel_id: string
  author: { id: string; name: string; display_name?: string; unclaimed: boolean; linked_user_id?: string }
  timestamp: string
  content: string
  reply_to?: string
  attachments: { id: string; filename: string; url?: string; content_type?: string; status?: string }[]
  provenance: 'discord_import'
}

export interface ImportedMessagePage { messages: ImportedMessage[]; has_more: boolean }

/** Go JSON collections may be null for empty structural channels. */
export function normalizeInventory(data: ImportInventory): ImportInventory {
  return { ...data,
    guilds: (data.guilds ?? []).map(guild => ({ ...guild, roles: guild.roles ?? [] })),
    channels: (data.channels ?? []).map(channel => ({ ...channel, authors: channel.authors ?? [],
      position: channel.position ?? 0, message_count: channel.message_count ?? 0, media_count: channel.media_count ?? 0 })),
    authors: data.authors ?? [], warnings: data.warnings ?? [],
    progress: data.progress ? { ...data.progress, stage: data.progress.stage ?? data.progress.state,
      completed: data.progress.completed ?? data.progress.processed } : undefined,
  }
}

const warningLabels: Record<string, string> = {
  source_announcement_mapped_to_text: 'Duyuru kanalları normal yazılı kanal olarak oluşturulur; duyuru yayımlama özelliği aktarılmaz.',
  source_stage_mapped_to_voice: 'Sahne kanalları normal sesli kanal olarak oluşturulur; konuşmacı ve dinleyici düzeni aktarılmaz.',
  source_forum_media_mapped_to_text: 'Forum ve medya kanalları yazılı kanala dönüştürülür; kaynak kanalın özel görünümü korunmaz.',
  source_private_thread_semantics_require_review: 'Özel başlıkların üyelik ve görünürlük düzeni aynı biçimde uygulanamaz. Paylaşmadan önce yeni kanal izinlerini incele.',
  source_guild_unknown_mapped_to_private_group: 'Sunucusu belirlenemeyen bir sohbet, yalnızca sana açık bir grup olarak oluşturulur.',
  imported_history_owner_only: 'Aktarılan geçmiş yalnızca sana görünür; sonradan sunucuya eklenen üyeler bu eski mesajlara otomatik erişemez.',
  archive_attribution_unverified: 'Arşivdeki yazar adları ve metinler bağımsız olarak doğrulanmış kimlik veya sahiplik kanıtı değildir.',
  personal_export_missing_counterpart_messages: 'Discord veri paketi yalnızca kendi gönderdiğin mesajları içeriyor. Karşı tarafların geçmişi bu kaynakta bulunmayabilir.',
  archive_completeness_unverified: 'Kaynak geçmişinin eksiksiz olduğu doğrulanamadı. Silinmiş veya erişilemeyen mesajlar bulunmayabilir.',
  mixed_source_completeness: 'Arşiv farklı kaynaklar içeriyor; bazı sohbetlerin geçmişi eksik olabilir.',
  source_ownership_not_transferred: 'Yeni bir kopya oluşturulur; Discord sunucusunun sahipliği devredilmez.',
  source_permissions_unverified: 'Kaynak izinleri bir arşivden okundu; güncel Discord erişim haklarını kanıtlamaz.',
  member_overwrites_unresolved_owner_only: 'Bazı kişiye özel kanal izinleri hesaplarla eşleştirilemedi. Bu geçmiş yalnızca sana açık tutulur.',
  unsupported_permission_bits: 'Bazı Discord izinlerinin Riparlare karşılığı yok. Desteklenmeyen yetkiler verilmez.',
  imported_roles_unassigned: 'Seçili roller oluşturulur; karşı hesaplar henüz eşleştirilmediği için kimseye otomatik atanmaz.',
  channel_overwrites_preserved_owner_only: 'Kaynak kanal izinleri kaydedilir; çözülmeyen izinler üzerinden başkasına geçmiş erişimi verilmez.',
  private_baseline_everyone_permissions_require_review: 'Sunucunun varsayılan @everyone erişimi kapalı başlar. Başkalarını eklemeden önce varsayılan rol ve kanal izinlerini kendin incelemelisin.',
  excluded_role_overwrite_not_applied: 'Hariç tuttuğun bir role bağlı kanal izni uygulanmadı; seçili rollerin izinlerini paylaşmadan önce incele.',
  reply_target_absent: 'Bazı yanıtların bağlı olduğu mesaj arşivde veya seçili içerikte bulunmuyor.',
  author_unknown: 'Bazı kaynak mesajların yazarı belirlenemedi.',
  author_metadata_varies: 'Bazı yazarların farklı kaynak sayfalarında farklı adları bulunuyor.',
  media_references_not_fetched: 'Bazı ekler yalnızca bağlantı olarak bulunuyor. Dosyası arşivde yoksa bu aktarımda kullanılamayabilir.',
  additional_message_fields_not_normalized: 'Bazı tepkiler, anketler, çıkartmalar veya ek mesaj özellikleri bu sürümde dönüştürülemiyor.',
}
export function importWarningText(code: string): string { return warningLabels[code] ?? code }

const unique = (items: string[]) => [...new Set(items)].sort()
export const isVoiceSource = (channel: SourceChannel) => channel.type === 2 || channel.type === 13
export const isCategorySource = (channel: SourceChannel) => channel.type === 4

export function sourceChannelLabel(type: number): string {
  return ({ 0: 'Yazılı kanal', 1: 'Özel sohbet', 2: 'Sesli kanalın sohbeti', 3: 'Grup sohbeti', 4: 'Kategori', 5: 'Duyuru kanalı', 10: 'Başlık', 11: 'Başlık', 12: 'Özel başlık', 13: 'Sahne kanalının sohbeti', 15: 'Forum', 16: 'Medya kanalı' } as Record<number, string>)[type] ?? 'Kanal'
}

export function emptySelection(inventory: ImportInventory): ImportSelection {
  return {
    channel_ids: [], excluded_author_ids: [], channel_excluded_author_ids: {}, guild_ids: [],
    role_ids: Object.fromEntries(inventory.guilds.map(guild => [guild.id, guild.roles.filter(role => !role.managed).map(role => role.id)])),
    include_messages: true, include_media: true, media_types: ['image', 'video', 'audio', 'file'],
    include_roles: true, include_permissions: true, include_voice_text: true, include_dms: false, include_groups: false,
  }
}

/** Descendants are bounded and cycle-safe because uploaded structure is untrusted. */
export function channelSubtree(channels: SourceChannel[], rootIds: string[]): string[] {
  const children = new Map<string, string[]>()
  const known = new Set(channels.map(channel => channel.id))
  for (const channel of channels) {
    if (channel.parent_id) children.set(channel.parent_id, [...(children.get(channel.parent_id) ?? []), channel.id])
  }
  const found = new Set<string>()
  const pending = rootIds.filter(id => known.has(id))
  while (pending.length) {
    const id = pending.pop()!
    if (found.has(id)) continue
    found.add(id)
    pending.push(...(children.get(id) ?? []))
  }
  return [...found]
}

export function toggleChannels(selection: ImportSelection, inventory: ImportInventory, ids: string[], include: boolean): ImportSelection {
  const changed = channelSubtree(inventory.channels, ids)
  const selected = new Set(selection.channel_ids)
  changed.forEach(id => include ? selected.add(id) : selected.delete(id))
  const newlySelected = inventory.channels.filter(channel => include && changed.includes(channel.id))
  return {
    ...selection, channel_ids: [...selected],
    include_dms: selection.include_dms || newlySelected.some(channel => channel.type === 1),
    include_groups: selection.include_groups || newlySelected.some(channel => channel.type === 3),
  }
}

/** Authoritative request excludes hidden-by-toggle source kinds; no stale checkbox leaks. */
export function canonicalSelection(selection: ImportSelection, inventory: ImportInventory): ImportSelection {
  const authors = new Set(inventory.authors.map(author => author.id))
  const channels = new Map(inventory.channels.map(channel => [channel.id, channel]))
  const channelIds = unique(selection.channel_ids).filter(id => {
    const channel = channels.get(id)
    // Voice text is a content choice: preserve the selected voice channel itself.
    return channel && (channel.type !== 1 || selection.include_dms)
      && (channel.type !== 3 || selection.include_groups)
  })
  const included = new Set(channelIds)
  const guildIds = new Set(selection.guild_ids.filter(id => inventory.guilds.some(guild => guild.id === id)))
  channelIds.forEach(id => { const guildId = channels.get(id)?.guild_id; if (guildId) guildIds.add(guildId) })
  const roleIds: Record<string, string[]> = {}
  if (selection.include_roles) {
    for (const guild of inventory.guilds) {
      if (guildIds.has(guild.id)) roleIds[guild.id] = unique(selection.role_ids[guild.id] ?? []).filter(id => guild.roles.some(role => role.id === id))
    }
  }
  const channelExcluded: Record<string, string[]> = {}
  for (const [channelId, ids] of Object.entries(selection.channel_excluded_author_ids)) {
    if (included.has(channelId)) channelExcluded[channelId] = unique(ids).filter(id => authors.has(id))
  }
  return {
    ...selection, channel_ids: channelIds, guild_ids: unique([...guildIds]), role_ids: roleIds,
    excluded_author_ids: unique(selection.excluded_author_ids).filter(id => authors.has(id)),
    channel_excluded_author_ids: channelExcluded,
    include_media: selection.include_messages && selection.include_media,
    media_types: selection.include_messages && selection.include_media ? [...new Set(selection.media_types)].sort() : [],
    after: selection.after || undefined, before: selection.before || undefined,
  }
}

/** Stable request fingerprint only invalidates local previews; server hashes remain authoritative. */
export function selectionFingerprint(selection: ImportSelection, inventory: ImportInventory): string {
  const canonical = canonicalSelection(selection, inventory)
  return JSON.stringify({ ...canonical,
    role_ids: Object.fromEntries(Object.entries(canonical.role_ids).sort(([a], [b]) => a.localeCompare(b))),
    channel_excluded_author_ids: Object.fromEntries(Object.entries(canonical.channel_excluded_author_ids).sort(([a], [b]) => a.localeCompare(b))),
  })
}

export function selectionDateError(selection: ImportSelection): string | null {
  const after = selection.after ? Date.parse(selection.after) : null
  const before = selection.before ? Date.parse(selection.before) : null
  if ((after !== null && !Number.isFinite(after)) || (before !== null && !Number.isFinite(before))) return 'Geçerli bir tarih seç.'
  if (after !== null && before !== null && after >= before) return 'Bitiş tarihi başlangıçtan sonra olmalı.'
  return null
}

const collectorErrors: Record<string, string> = {
  SOURCE_CHANNEL_LIMIT: 'Tek aktarımda en fazla 3000 kanal seçebilirsin. Daha az sunucu veya kanal seç; mevcut seçimlerin korundu.',
  SOURCE_GUILD_LIMIT: 'Tek aktarımda en fazla 2000 sunucu seçebilirsin. Daha az sunucu seç.',
  SOURCE_MESSAGE_LIMIT: 'Bu seçim 100.000 mesaj sınırını aşıyor. Daha az kanal seçerek ayrı bir aktarım hazırla.',
  SOURCE_INSPECTION_LIMIT: 'Seçili geçmiş cihazdaki 32 MB inceleme sınırını aşıyor. Daha az kanal seç.',
  SOURCE_ARCHIVE_LIMIT: 'Hazırlanan arşiv 64 MB sınırını aşıyor. Daha az kanal veya dosya türü seç.',
  SOURCE_ENTRY_LIMIT: 'Bu aktarım 4095 dosya ve mesaj bölümü sınırını aşıyor. Daha az kanal veya ek seç.',
  SOURCE_TIMEOUT: 'Discord yanıtı zaman aşımına uğradı. Yeniden deneyebilir veya daha az kaynak seçebilirsin.',
  SOURCE_RESCAN_REQUIRED: 'Mesaj geçmişi seçimini değiştirdin. Kaynağı değiştirip yeniden bağlandıktan sonra içeriği tekrar hazırla.',
}

/** Electron may wrap safe codes in its own prefix; never expose arbitrary raw errors. */
export function collectorErrorMessage(error: unknown, fallback: string): string {
  const message = error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' ? error.message : ''
  const code = message.match(/(?:^|[^A-Za-z0-9_])(SOURCE_[A-Z_]+)(?=$|[^A-Za-z0-9_])/)?.[1]
  return code && Object.hasOwn(collectorErrors, code) ? collectorErrors[code] : fallback
}

export function selectionLimitError(selection: Pick<ImportSelection, 'channel_ids' | 'guild_ids'>): string | null {
  if (new Set(selection.channel_ids).size > 3000) return collectorErrors.SOURCE_CHANNEL_LIMIT
  if (new Set(selection.guild_ids).size > 2000) return collectorErrors.SOURCE_GUILD_LIMIT
  return null
}

export function destinationPath(destination: ImportDestination): string | null {
  if (destination.guild_id && destination.channel_id) return `/app/${encodeURIComponent(destination.guild_id)}/${encodeURIComponent(destination.channel_id)}`
  if (destination.channel_id) return `/app/@me/${encodeURIComponent(destination.channel_id)}`
  if (destination.guild_id) return `/app/${encodeURIComponent(destination.guild_id)}`
  return null
}

/** Never attach native bearer credentials to an archive-supplied arbitrary URL. */
export function ownedImportMediaUrl(raw: string | undefined): string | null {
  if (!raw) return null
  try {
    const base = new URL(getApiBaseUrl(), window.location.href)
    const target = new URL(raw, base.origin)
    const prefix = base.pathname.replace(/\/$/, '') + '/discord-imports/'
    if (target.origin !== base.origin || target.search || target.hash || target.username || target.password) return null
    if (!target.pathname.startsWith(prefix)) return null
    const route = target.pathname.slice(prefix.length)
    if (!/^[A-Za-z0-9_-]+\/media\/[0-9]+\/[0-9]+\/(?:[0-9]+|index-[0-9]+)$/.test(route)) return null
    return target.toString()
  } catch { return null }
}

const root = () => `${getApiBaseUrl()}/discord-imports`
export const discordMigrationApi = {
  async adoptUsername(username: string): Promise<UsernameAdoption> {
    try {
      await axiosInstance.patch(`${getApiBaseUrl()}/user/me/discriminator`, { discriminator: username.trim() })
      return 'updated'
    } catch (failure) {
      if (axios.isAxiosError(failure) && failure.response?.status === 409) return 'taken'
      if (axios.isAxiosError(failure) && failure.response?.status === 400) return 'invalid'
      return 'failed'
    }
  },
  async upload(file: File, signal?: AbortSignal, onProgress?: (percent: number) => void): Promise<ImportInventory> {
    const data = new FormData()
    data.append('file', file)
    return normalizeInventory((await axiosInstance.post<ImportInventory>(`${root()}/archive`, data, { signal,
      onUploadProgress: event => { if (event.total) onProgress?.(Math.round(event.loaded / event.total * 100)) },
    })).data)
  },
  async list(signal?: AbortSignal): Promise<ImportInventory[]> {
    return ((await axiosInstance.get<ImportInventory[]>(root(), { signal })).data ?? []).map(normalizeInventory)
  },
  async get(id: string, signal?: AbortSignal): Promise<ImportInventory> {
    return normalizeInventory((await axiosInstance.get<ImportInventory>(`${root()}/${encodeURIComponent(id)}`, { signal })).data)
  },
  async preview(id: string, selection: ImportSelection, signal?: AbortSignal): Promise<ImportPreview> {
    const data = (await axiosInstance.post<ImportPreview>(`${root()}/${encodeURIComponent(id)}/preview`, selection, { signal })).data
    return { ...data, warnings: data.warnings ?? [] }
  },
  async commit(id: string, selection: ImportSelection, selectionHash: string): Promise<ImportInventory> {
    return normalizeInventory((await axiosInstance.post<ImportInventory>(`${root()}/${encodeURIComponent(id)}/commit`, { selection, selection_hash: selectionHash })).data)
  },
  async messages(channelId: string, before?: string, signal?: AbortSignal): Promise<ImportedMessagePage> {
    const data = (await axiosInstance.get<ImportedMessagePage>(`${root()}/channels/${encodeURIComponent(channelId)}/messages`, {
      params: { before, limit: 50 }, signal,
    })).data
    return { messages: data.messages ?? [], has_more: !!data.has_more }
  },
  async media(url: string, signal?: AbortSignal): Promise<Blob> {
    const owned = ownedImportMediaUrl(url)
    if (!owned) throw new Error('Bu dosya için güvenilir bir aktarım bağlantısı yok.')
    return (await axiosInstance.get<Blob>(owned, { responseType: 'blob', signal, transformResponse: [data => data] })).data
  },
}
