import { useMemo, useState } from 'react'
import { Search, Shield, UserRoundX } from 'lucide-react'
import { cn } from '@/lib/utils'
import { sourceChannelLabel, type ImportInventory, type ImportSelection, type MediaKind } from '@/lib/discordMigration'

function Choice({ checked, onChange, title, detail, disabled = false }: { checked: boolean; onChange: (value: boolean) => void; title: string; detail?: string; disabled?: boolean }) {
  return <label className={cn('flex items-start gap-3 py-3', disabled && 'opacity-50')}>
    <input type="checkbox" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-white" />
    <span><span className="block text-sm font-medium">{title}</span>{detail && <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{detail}</span>}</span>
  </label>
}

export default function ImportOptions({ inventory, selection, onChange, focusedId }: {
  inventory: ImportInventory
  selection: ImportSelection
  onChange: (value: ImportSelection) => void
  focusedId: string | null
}) {
  const [tab, setTab] = useState<'channel' | 'authors' | 'content' | 'roles'>('channel')
  const [authorSearch, setAuthorSearch] = useState('')
  const [authorLimit, setAuthorLimit] = useState(80)
  const focused = inventory.channels.find(channel => channel.id === focusedId)
  const focusedGuild = inventory.guilds.find(guild => guild.id === focused?.guild_id) ?? inventory.guilds.find(guild => selection.guild_ids.includes(guild.id))
  const [roleGuildId, setRoleGuildId] = useState('')
  const roleGuild = inventory.guilds.find(guild => guild.id === roleGuildId) ?? focusedGuild ?? inventory.guilds[0]
  const relevantAuthors = useMemo(() => {
    const needle = authorSearch.toLocaleLowerCase('tr')
    return inventory.authors.filter(author => (tab !== 'channel' || focused?.authors.some(item => item.id === author.id))
      && `${author.name} ${author.display_name ?? ''} ${author.id}`.toLocaleLowerCase('tr').includes(needle))
      .sort((a, b) => b.message_count - a.message_count)
  }, [inventory.authors, focused, tab, authorSearch])
  const patch = (value: Partial<ImportSelection>) => onChange({ ...selection, ...value })
  function toggleAuthor(id: string, excluded: boolean, channelId?: string) {
    const current = channelId ? selection.channel_excluded_author_ids[channelId] ?? [] : selection.excluded_author_ids
    const next = excluded ? [...new Set([...current, id])] : current.filter(item => item !== id)
    if (channelId) patch({ channel_excluded_author_ids: { ...selection.channel_excluded_author_ids, [channelId]: next } })
    else patch({ excluded_author_ids: next })
  }
  function localDate(value?: string) {
    if (!value) return ''
    const date = new Date(value)
    if (!Number.isFinite(date.getTime())) return ''
    return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
  }
  function updateDate(key: 'after' | 'before', value: string) {
    patch({ [key]: value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : undefined })
  }
  const authorList = (perChannel: boolean) => <>
    <div className="relative mb-3 mt-4"><Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" /><input value={authorSearch} onChange={event => { setAuthorSearch(event.target.value); setAuthorLimit(80) }} placeholder="İsim veya Discord kimliği ara" aria-label="Mesaj yazarlarında ara" className="w-full rounded-md border bg-background py-2 pl-9 pr-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" /></div>
    <p className="mb-2 text-xs text-muted-foreground">İşaretli kişilerin mesajları ve onlara ait ekler aktarılmayacak.</p>
    <div className="divide-y rounded-lg border px-3">
      {relevantAuthors.slice(0, authorLimit).map(author => {
        const globallyExcluded = selection.excluded_author_ids.includes(author.id)
        const excluded = globallyExcluded || Boolean(perChannel && focused && selection.channel_excluded_author_ids[focused.id]?.includes(author.id))
        const count = perChannel ? focused?.authors.find(item => item.id === author.id)?.count ?? 0 : author.message_count
        return <label key={author.id} className={cn('flex items-center gap-3 py-3', perChannel && globallyExcluded && 'opacity-50')}>
          <input type="checkbox" checked={excluded} disabled={perChannel && globallyExcluded} onChange={event => toggleAuthor(author.id, event.target.checked, perChannel ? focused?.id : undefined)} className="h-4 w-4 shrink-0 accent-white" />
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">{(author.display_name || author.name || '?').slice(0, 1)}</span>
          <span className="min-w-0 flex-1"><span className="block truncate text-sm">{author.display_name || author.name || author.id}</span><span className="block text-xs text-muted-foreground">{perChannel && globallyExcluded ? 'Tüm aktarımda hariç' : `${count.toLocaleString('tr-TR')} mesaj`}</span></span>
          {excluded && <UserRoundX className="h-4 w-4 text-muted-foreground" aria-hidden />}
        </label>
      })}
      {relevantAuthors.length === 0 && <p className="py-5 text-sm text-muted-foreground">Bu seçimde mesaj yazarı bulunamadı.</p>}
    </div>
    {relevantAuthors.length > authorLimit && <button type="button" onClick={() => setAuthorLimit(count => count + 80)} className="mt-3 text-sm underline underline-offset-4">Sonraki 80 kişiyi göster</button>}
  </>

  return <section className="flex h-full min-h-0 flex-col" aria-label="Ayrıntılı aktarım ayarları">
    <div className="flex shrink-0 gap-1 overflow-x-auto border-b px-3 pt-3" role="tablist" aria-label="Aktarım filtreleri">
      {([['channel', 'Seçili kanal'], ['authors', 'Kişiler'], ['content', 'İçerik'], ['roles', 'Roller ve izinler']] as const).map(([value, label]) => <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => { setTab(value); setAuthorSearch(''); setAuthorLimit(80) }} className={cn('whitespace-nowrap border-b-2 px-3 pb-3 text-sm', tab === value ? 'border-foreground text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}>{label}</button>)}
    </div>
    <div className="min-h-60 flex-1 overflow-y-auto p-5 sm:p-6" role="tabpanel">
      {tab === 'channel' && (focused ? <>
        <p className="text-xs text-muted-foreground">{focusedGuild?.name ?? (focused.type === 3 ? 'Grup sohbeti' : 'Özel sohbet')} / {sourceChannelLabel(focused.type)}</p>
        <h3 className="mt-1 break-words text-xl font-semibold">{focused.name || sourceChannelLabel(focused.type)}</h3>
        <p className="mt-2 text-sm text-muted-foreground">{focused.message_count.toLocaleString('tr-TR')} mesaj, {focused.media_count.toLocaleString('tr-TR')} ek</p>
        <p className="mt-5 text-sm leading-relaxed text-muted-foreground">Buradan yalnızca bu kanalda hariç tutacağın kişileri seçebilirsin. Diğer kanallardaki mesajları bu seçimden etkilenmez.</p>
        {authorList(true)}
      </> : <div className="flex h-full min-h-64 flex-col items-center justify-center text-center"><UserRoundX className="mb-4 h-7 w-7 text-muted-foreground" /><h3 className="text-lg font-semibold">Bir kanal seç</h3><p className="mt-2 max-w-xs text-sm leading-relaxed text-muted-foreground">Soldaki kanal adına tıklayıp yalnızca o kanaldaki kişileri ve mesaj sayılarını incele.</p></div>)}
      {tab === 'authors' && <><h3 className="text-lg font-semibold">Kimlerin mesajları aktarılmasın?</h3><p className="mt-2 text-sm leading-relaxed text-muted-foreground">Buradaki seçim bütün kanallara, gruplara ve özel sohbetlere uygulanır. Kişilerin hesapları oluşturulmaz; eski mesajlar kaynak yazarıyla gösterilir.</p>{authorList(false)}</>}
      {tab === 'content' && <>
        <h3 className="text-lg font-semibold">Neleri taşımak istiyorsun?</h3>
        <div className="mt-3 divide-y">
          <Choice checked={selection.include_messages} onChange={value => patch({ include_messages: value })} title="Mesaj geçmişi" detail="Kapatırsan yalnızca seçili sunucu, kanal ve rol yapıları oluşturulur." />
          <Choice checked={selection.include_voice_text} onChange={value => patch({ include_voice_text: value })} title="Sesli ve sahne kanallarının yazılı sohbetleri" detail="Ses kayıtlarını değil, bu kanallara yazılmış mesajları aktarır." />
          <Choice checked={selection.include_dms} onChange={value => patch({ include_dms: value })} title="Özel sohbetler" detail="Yalnızca seçtiğin sohbetler aktarılır. Diğer hesaplar otomatik eklenmez." />
          <Choice checked={selection.include_groups} onChange={value => patch({ include_groups: value })} title="Grup sohbetleri" detail="Grupları tek tek seçebilirsin. Aktarılan geçmiş başlangıçta yalnızca sana görünür." />
          <Choice checked={selection.include_media} disabled={!selection.include_messages} onChange={value => patch({ include_media: value })} title="Mesaj ekleri" detail="Arşivde bulunan ve aşağıda seçtiğin türlerdeki dosyalar. Eksik veya süresi dolmuş ekler önizlemede belirtilir." />
        </div>
        <fieldset disabled={!selection.include_media || !selection.include_messages} className="mt-3 rounded-lg border p-4 disabled:opacity-45"><legend className="px-1 text-sm font-medium">Ek türleri</legend><div className="grid grid-cols-2 gap-x-5 gap-y-3">{([['image', 'Fotoğraf ve GIF'], ['video', 'Video'], ['audio', 'Ses dosyası'], ['file', 'Diğer dosyalar']] as [MediaKind, string][]).map(([kind, label]) => <label key={kind} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={selection.media_types.includes(kind)} onChange={event => patch({ media_types: event.target.checked ? [...new Set([...selection.media_types, kind])] : selection.media_types.filter(item => item !== kind) })} className="h-4 w-4 accent-white" />{label}</label>)}</div></fieldset>
        <fieldset disabled={!selection.include_messages} className="mt-6 space-y-3 disabled:opacity-45"><legend className="mb-2 text-sm font-medium">Mesajların tarih aralığı</legend><p className="text-xs text-muted-foreground">Boş bırakırsan mevcut geçmişin tamamı seçilir. Saatler bu cihazın saat dilimindedir; bitiş anındaki mesaj dahil edilmez.</p><div className="grid gap-3 sm:grid-cols-2"><label className="space-y-1 text-xs text-muted-foreground"><span>Başlangıç (dahil)</span><input type="datetime-local" value={localDate(selection.after)} onChange={event => updateDate('after', event.target.value)} className="w-full rounded-md border bg-background px-3 py-2 text-sm text-foreground [color-scheme:dark]" /></label><label className="space-y-1 text-xs text-muted-foreground"><span>Bitiş (hariç)</span><input type="datetime-local" value={localDate(selection.before)} onChange={event => updateDate('before', event.target.value)} className="w-full rounded-md border bg-background px-3 py-2 text-sm text-foreground [color-scheme:dark]" /></label></div><button type="button" onClick={() => patch({ after: undefined, before: undefined })} className="text-xs underline underline-offset-4">Tarih sınırını kaldır</button></fieldset>
      </>}
      {tab === 'roles' && <>
        <h3 className="text-lg font-semibold">Roller ve kanal izinleri</h3>
        <div className="mt-3 divide-y"><Choice checked={selection.include_roles} onChange={value => patch({ include_roles: value })} title="Seçili rolleri oluştur" detail="Rol adları, renkleri ve sıraları yeni sunucuda korunur. Discord üyeleri otomatik oluşturulmaz." /><Choice checked={selection.include_permissions} onChange={value => patch({ include_permissions: value })} title="Desteklenen izinleri aktar" detail="İzinler Riparlare karşılıklarına dönüştürülür. Eşleştirilemeyen kişi izinleri ve özellikler önizlemede gösterilir." /></div>
        <div className="mt-4 flex items-start gap-2 rounded-md bg-muted/60 p-3 text-xs leading-relaxed text-muted-foreground"><Shield className="mt-0.5 h-4 w-4 shrink-0" />Yeni sunucu başlangıçta sana özeldir. Sunucuyu kopyalamak Discord'daki sahipliği veya üyelerin hesaplarını devretmez.</div>
        {roleGuild ? <><label className="mb-3 mt-5 block text-sm">Sunucu<select value={roleGuild.id} onChange={event => setRoleGuildId(event.target.value)} className="mt-2 block w-full rounded-md border bg-background px-3 py-2">{inventory.guilds.map(guild => <option key={guild.id} value={guild.id}>{guild.name}</option>)}</select></label><div className="divide-y rounded-lg border px-3">{[...roleGuild.roles].sort((a, b) => b.position - a.position).map(role => <label key={role.id} className={cn('flex items-center gap-3 py-3 text-sm', (!selection.include_roles || role.managed) && 'opacity-50')}><input type="checkbox" disabled={!selection.include_roles || role.managed} checked={!role.managed && Boolean(selection.role_ids[roleGuild.id]?.includes(role.id))} onChange={event => { const current = selection.role_ids[roleGuild.id] ?? []; patch({ role_ids: { ...selection.role_ids, [roleGuild.id]: event.target.checked ? [...new Set([...current, role.id])] : current.filter(id => id !== role.id) } }) }} className="h-4 w-4 accent-white" /><span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: role.color ? `#${(role.color & 0xffffff).toString(16).padStart(6, '0')}` : '#a1a1aa' }} /><span className="min-w-0 flex-1 truncate">{role.name}</span>{role.managed && <span className="text-xs text-muted-foreground">Bot tarafından yönetiliyor</span>}</label>)}{roleGuild.roles.length === 0 && <p className="py-4 text-sm text-muted-foreground">Bu kaynakta rol bilgisi bulunmuyor.</p>}</div></> : <p className="mt-6 text-sm text-muted-foreground">Arşivde sunucu veya rol bilgisi bulunamadı.</p>}
      </>}
    </div>
  </section>
}
