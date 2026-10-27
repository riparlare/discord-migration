import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Download, File, History, Loader2, ShieldCheck } from 'lucide-react'
import { discordMigrationApi, ownedImportMediaUrl, type ImportedMessage } from '@/lib/discordMigration'

function ImportedAttachment({ attachment }: { attachment: ImportedMessage['attachments'][number] }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const controller = useRef<AbortController | null>(null)
  const currentUrl = useRef<string | null>(null)
  const safeUrl = ownedImportMediaUrl(attachment.url)
  useEffect(() => () => {
    controller.current?.abort()
    if (currentUrl.current) URL.revokeObjectURL(currentUrl.current)
  }, [])
  async function open() {
    if (!safeUrl || busy) return
    const request = new AbortController()
    controller.current = request
    setBusy(true); setError(false)
    try {
      const blob = await discordMigrationApi.media(safeUrl, request.signal)
      if (request.signal.aborted) return
      const url = URL.createObjectURL(blob)
      if (currentUrl.current) URL.revokeObjectURL(currentUrl.current)
      currentUrl.current = url
      // SVG/HTML and unknown content are downloads, never embedded active documents.
      if (/^image\/(?:png|jpeg|gif|webp|avif)$/.test(blob.type)) setPreviewUrl(url)
      else {
        const link = document.createElement('a')
        link.href = url
        link.download = attachment.filename || 'aktarilan-dosya'
        link.rel = 'noopener'
        link.click()
      }
    } catch { if (!request.signal.aborted) setError(true) }
    finally { if (!request.signal.aborted) setBusy(false) }
  }
  return <div className="mt-2 max-w-md">
    <button type="button" disabled={!safeUrl || busy} onClick={() => void open()} className="flex max-w-full items-center gap-2 rounded-md border bg-background/50 px-3 py-2 text-left text-xs disabled:opacity-50">
      {busy ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" /> : <File className="h-4 w-4 shrink-0 text-muted-foreground" />}<span className="truncate">{attachment.filename || 'Dosya'}</span>{safeUrl && <Download className="ml-2 h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
    </button>
    {!safeUrl && <p className="mt-1 text-xs text-muted-foreground">Bu ek arşivde bulunmuyor veya aktarılmadı.</p>}
    {error && <p role="alert" className="mt-1 text-xs text-destructive">Dosya açılamadı. Erişimin değişmiş veya dosya eksik olabilir.</p>}
    {previewUrl && <img src={previewUrl} alt={attachment.filename || 'Aktarılan görsel'} className="mt-2 max-h-72 max-w-full rounded-lg object-contain" />}
  </div>
}

/** Separate source provenance; never fabricates native message/edit/profile rights. */
export default function ImportedHistory({ channelId }: { channelId: string }) {
  const [messages, setMessages] = useState<ImportedMessage[]>([])
  const [loadedFor, setLoadedFor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const requestRef = useRef<AbortController | null>(null)
  const activeChannel = useRef(channelId)

  useEffect(() => {
    activeChannel.current = channelId
    const request = new AbortController()
    requestRef.current = request
    setMessages([]); setLoadedFor(null); setHasMore(false); setOpen(false); setError(false); setLoading(true)
    discordMigrationApi.messages(channelId, undefined, request.signal).then(data => {
      if (request.signal.aborted || activeChannel.current !== channelId) return
      setMessages(data.messages ?? []); setHasMore(data.has_more); setLoadedFor(channelId)
    }).catch(() => {
      // Absence of permission/import support must not block ordinary live chat.
      if (!request.signal.aborted && activeChannel.current === channelId) setError(true)
    }).finally(() => { if (!request.signal.aborted && activeChannel.current === channelId) setLoading(false) })
    return () => request.abort()
  }, [channelId])

  async function older() {
    if (loading || !hasMore || !messages.length) return
    const request = new AbortController()
    requestRef.current?.abort(); requestRef.current = request
    setLoading(true); setError(false)
    try {
      const data = await discordMigrationApi.messages(channelId, messages[messages.length - 1].id, request.signal)
      if (request.signal.aborted || activeChannel.current !== channelId) return
      setMessages(previous => { const seen = new Set(previous.map(message => message.id)); return [...previous, ...data.messages.filter(message => !seen.has(message.id))] })
      setHasMore(data.has_more)
    } catch { if (!request.signal.aborted) setError(true) }
    finally { if (!request.signal.aborted) setLoading(false) }
  }

  useEffect(() => () => requestRef.current?.abort(), [])
  if (loadedFor !== channelId || messages.length === 0) return null
  return <section className="shrink-0 border-b bg-card/40" aria-label="Discord’dan aktarılan sohbet geçmişi" data-testid="imported-history">
    <button type="button" onClick={() => setOpen(value => !value)} aria-expanded={open} className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm hover:bg-accent/40">
      {open ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}<History className="h-4 w-4 text-muted-foreground" /><span>Discord’dan aktarılan geçmiş</span><span className="ml-auto text-xs text-muted-foreground">Yalnızca sana görünür</span>
    </button>
    {open && <div className="max-h-[min(48vh,420px)] overflow-y-auto border-t px-4 py-3">
      <div className="mb-4 flex items-start gap-2 text-xs leading-relaxed text-muted-foreground"><ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" /><p>Bu mesajlar bir Discord arşivinden aktarıldı. İsimler kaynak kayıtlardır; sahiplenilmemiş kişiler için Riparlare hesabı oluşturulmadı.</p></div>
      {hasMore && <button type="button" disabled={loading} onClick={() => void older()} className="mb-5 flex items-center gap-2 rounded-md border px-3 py-2 text-xs hover:bg-accent disabled:opacity-50">{loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}Daha eski mesajları getir</button>}
      {error && <p role="alert" className="mb-3 text-xs text-destructive">Eski mesajlar yüklenemedi. Yeniden deneyebilirsin.</p>}
      <div className="space-y-5">{[...messages].reverse().map(message => <article key={message.id} className="flex gap-3" data-source-message-id={message.id}>
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground">{(message.author.display_name || message.author.name || '?').slice(0, 1)}</div>
        <div className="min-w-0 flex-1"><div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5"><span className="text-sm font-semibold">{message.author.display_name || message.author.name || message.author.id}</span><span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{message.author.unclaimed ? 'Sahiplenilmemiş' : 'Discord kaydı'}</span><time dateTime={message.timestamp} title={new Date(message.timestamp).toISOString()} className="text-[11px] text-muted-foreground">{new Date(message.timestamp).toLocaleString()}</time></div>
          {message.reply_to && <p className="mt-1 truncate text-xs text-muted-foreground">Yanıtlanan kaynak mesaj: {message.reply_to}</p>}
          <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed [overflow-wrap:anywhere]">{message.content}</p>
          {message.attachments?.map(attachment => <ImportedAttachment key={attachment.id} attachment={attachment} />)}
        </div>
      </article>)}</div>
    </div>}
  </section>
}
