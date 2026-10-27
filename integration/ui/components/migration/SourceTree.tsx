import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Folder, Hash, MessageCircle, Search, Users, Volume2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { channelSubtree, isCategorySource, isVoiceSource, sourceChannelLabel, toggleChannels, type ImportInventory, type ImportSelection, type SourceChannel } from '@/lib/discordMigration'

function SourceIcon({ channel }: { channel: SourceChannel }) {
  const Icon = isCategorySource(channel) ? Folder : isVoiceSource(channel) ? Volume2 : channel.type === 3 ? Users : channel.type === 1 ? MessageCircle : Hash
  return <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
}

export default function SourceTree({ inventory, selection, onChange, focusedId, onFocus }: {
  inventory: ImportInventory
  selection: ImportSelection
  onChange: (selection: ImportSelection) => void
  focusedId: string | null
  onFocus: (id: string) => void
}) {
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [visibleCount, setVisibleCount] = useState(120)
  const selected = useMemo(() => new Set(selection.channel_ids), [selection.channel_ids])
  const channels = useMemo(() => [...inventory.channels].sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || a.id.localeCompare(b.id)), [inventory.channels])
  const byId = useMemo(() => new Map(channels.map(channel => [channel.id, channel])), [channels])
  const childMap = useMemo(() => {
    const result = new Map<string, SourceChannel[]>()
    for (const channel of channels) {
      if (channel.parent_id) {
        const key = `${channel.guild_id ?? ''}:${channel.parent_id}`
        result.set(key, [...(result.get(key) ?? []), channel])
      }
    }
    return result
  }, [channels])
  const matching = useMemo(() => {
    if (!query.trim()) return null
    const needle = query.toLocaleLowerCase('tr')
    const matchingGuilds = new Set(inventory.guilds.filter(guild => `${guild.name} ${guild.id}`.toLocaleLowerCase('tr').includes(needle)).map(guild => guild.id))
    const found = new Set<string>()
    for (const channel of channels) {
      if (!matchingGuilds.has(channel.guild_id ?? '') && !`${channel.name} ${channel.id}`.toLocaleLowerCase('tr').includes(needle)) continue
      found.add(channel.id)
      let parent = channel.parent_id
      while (parent && !found.has(parent)) { found.add(parent); parent = byId.get(parent)?.parent_id }
    }
    return found
  }, [byId, channels, query, inventory.guilds])
  const visibleRows = useMemo(() => {
    const rows: { channel: SourceChannel; depth: number }[] = []
    const seen = new Set<string>()
    const visit = (channel: SourceChannel, depth: number) => {
      if (seen.has(channel.id) || depth > 24 || (matching && !matching.has(channel.id))) return
      seen.add(channel.id)
      rows.push({ channel, depth })
      if (!collapsed.has(channel.id) || matching) {
        childMap.get(`${channel.guild_id ?? ''}:${channel.id}`)?.forEach(child => visit(child, depth + 1))
      }
    }
    for (const guild of inventory.guilds) {
      channels.filter(channel => channel.guild_id === guild.id && (!channel.parent_id || !byId.has(channel.parent_id) || byId.get(channel.parent_id)?.guild_id !== guild.id)).forEach(channel => visit(channel, 0))
      // Broken/cyclic source parents remain selectable as orphan roots.
      channels.filter(channel => channel.guild_id === guild.id && !seen.has(channel.id)).forEach(channel => {
        const ancestors = new Set<string>([channel.id])
        let parent = channel.parent_id
        let cycle = false
        while (parent) {
          if (ancestors.has(parent)) { cycle = true; break }
          ancestors.add(parent); parent = byId.get(parent)?.parent_id
        }
        if (cycle || matching || !channel.parent_id || !byId.has(channel.parent_id)) visit(channel, 0)
      })
    }
    channels.filter(channel => !channel.guild_id).forEach(channel => visit(channel, 0))
    return rows
  }, [inventory.guilds, channels, matching, collapsed, byId, childMap])

  function collapse(id: string) {
    setCollapsed(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next })
  }
  function toggleGuild(id: string, checked: boolean) {
    const ids = channels.filter(channel => channel.guild_id === id).map(channel => channel.id)
    const next = toggleChannels(selection, inventory, ids, checked)
    next.guild_ids = checked ? [...new Set([...next.guild_ids, id])] : next.guild_ids.filter(guildId => guildId !== id)
    onChange(next)
  }
  let previousGroup = ''
  return <section className="flex h-full min-h-0 flex-col" aria-label="Aktarılacak kanallar">
    <div className="relative border-b p-3">
      <Search className="pointer-events-none absolute left-6 top-6 h-4 w-4 text-muted-foreground" />
      <input value={query} onChange={event => { setQuery(event.target.value); setVisibleCount(120) }} placeholder="Sunucu, kanal veya kimlik ara" aria-label="Kaynaklarda ara" className="w-full rounded-md border bg-background py-2 pl-9 pr-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" />
    </div>
    <div className="flex items-center justify-between gap-2 border-b px-4 py-2 text-xs">
      <span className="text-muted-foreground">{selection.channel_ids.length} kanal seçili</span>
      <div className="flex gap-3">
        <button type="button" className="hover:underline" onClick={() => onChange({ ...toggleChannels(selection, inventory, channels.map(channel => channel.id), true), guild_ids: inventory.guilds.map(guild => guild.id) })}>Tümü</button>
        <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => onChange({ ...selection, channel_ids: [], guild_ids: [] })}>Temizle</button>
      </div>
    </div>
    <div className="min-h-40 flex-1 overflow-y-auto px-2 pb-4">
      {visibleRows.slice(0, visibleCount).map(({ channel, depth }) => {
        const group = channel.guild_id || (channel.type === 3 ? 'groups' : 'dms')
        const newGroup = group !== previousGroup
        previousGroup = group
        const guild = inventory.guilds.find(item => item.id === channel.guild_id)
        const descendants = isCategorySource(channel) ? channelSubtree(channels, [channel.id]) : [channel.id]
        const selectedCount = descendants.filter(id => selected.has(id)).length
        const disabled = channel.type === 1 && !selection.include_dms || channel.type === 3 && !selection.include_groups || isVoiceSource(channel) && !selection.include_voice_text
        return <div key={channel.id}>
          {newGroup && <div className="mb-1 mt-4 flex items-center gap-2 px-2 py-1.5 text-sm font-semibold">
            {guild && <input type="checkbox" checked={selection.guild_ids.includes(guild.id) || channels.filter(item => item.guild_id === guild.id).every(item => selected.has(item.id))} onChange={event => toggleGuild(guild.id, event.target.checked)} aria-label={`${guild.name} sunucusunu seç`} className="h-4 w-4 accent-white" />}
            <span className="truncate">{guild?.name ?? (channel.type === 3 ? 'Grup sohbetleri' : 'Özel sohbetler')}</span>
          </div>}
          <div className={cn('flex items-center gap-1.5 rounded-md py-1.5 pr-2', focusedId === channel.id ? 'bg-accent' : 'hover:bg-accent/50', disabled && 'opacity-55')} style={{ paddingLeft: `${8 + Math.min(depth, 12) * 14}px` }}>
            {isCategorySource(channel) ? <button type="button" onClick={() => collapse(channel.id)} aria-label={`${channel.name} kategorisini ${collapsed.has(channel.id) ? 'aç' : 'daralt'}`} aria-expanded={!collapsed.has(channel.id)} className="rounded p-0.5 text-muted-foreground hover:text-foreground">
              {collapsed.has(channel.id) ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            </button> : <span className="w-[18px] shrink-0" />}
            <input type="checkbox" checked={selectedCount === descendants.length} ref={node => { if (node) node.indeterminate = selectedCount > 0 && selectedCount < descendants.length }} onChange={event => onChange(toggleChannels(selection, inventory, [channel.id], event.target.checked))} aria-label={`${channel.name || channel.id} aktarımını seç`} className="h-4 w-4 shrink-0 accent-white" />
            <button type="button" onClick={() => onFocus(channel.id)} className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm" title={`${sourceChannelLabel(channel.type)} · ${channel.id}`}>
              <SourceIcon channel={channel} />
              <span className="truncate">{channel.name || sourceChannelLabel(channel.type)}</span>
              <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">{channel.message_count || ''}</span>
            </button>
          </div>
        </div>
      })}
      {visibleRows.length === 0 && <p className="px-3 py-8 text-center text-sm text-muted-foreground">Bu aramada kanal bulunamadı.</p>}
      {visibleRows.length > visibleCount && <button type="button" onClick={() => setVisibleCount(count => count + 120)} className="mx-2 mt-4 rounded-md border px-3 py-2 text-sm hover:bg-accent">Sonraki 120 kanalı göster ({visibleRows.length - visibleCount} kaldı)</button>}
      {inventory.guilds.filter(guild => !channels.some(channel => channel.guild_id === guild.id)).map(guild => <label key={guild.id} className="mt-4 flex items-center gap-2 px-2 py-2 text-sm"><input type="checkbox" checked={selection.guild_ids.includes(guild.id)} onChange={event => toggleGuild(guild.id, event.target.checked)} className="h-4 w-4 accent-white" /><span>{guild.name}</span><span className="ml-auto text-xs text-muted-foreground">Yalnızca yapı</span></label>)}
    </div>
  </section>
}
