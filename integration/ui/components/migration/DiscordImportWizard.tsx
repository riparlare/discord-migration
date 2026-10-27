import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, ArrowLeft, ArrowRight, Check, CheckCircle2, FileArchive, FolderInput, Loader2, RefreshCw, ShieldCheck, Upload, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { apiErrorMessage } from '@/lib/apiError'
import { queryClient } from '@/lib/queryClient'
import { useAuthStore } from '@/stores/authStore'
import type { DtoUser } from '@/types'
import { canonicalSelection, collectorErrorMessage, destinationPath, discordMigrationApi, emptySelection, importWarningText, importUploadErrorMessage, rejectedImportSnapshot, normalizeInventory, selectionDateError, selectionFingerprint, selectionLimitError, toggleChannels, type DiscordSourceAccount, type ImportInventory, type ImportPreview, type ImportSelection, type SourceChannel, type SourceGuild, type UsernameAdoption } from '@/lib/discordMigration'
import SourceTree from './SourceTree'
import ImportOptions from './ImportOptions'

interface CollectorProgress {
  phase: 'discovery' | 'messages' | 'media' | 'packing'; channel_id?: string; messages: number; media: number
  guild_id?: string; guild_name?: string; guilds_discovered?: number; waiting_ms?: number
}
interface DesktopMigrationBridge {
  connect: (input: { token: string; acceptedRisk: true }) => Promise<{ guilds: SourceGuild[]; channels: SourceChannel[]; warnings: string[]; account?: DiscordSourceAccount }>
  inspectGuild?: (guildId: string) => Promise<{ guilds: SourceGuild[]; channels: SourceChannel[]; warnings: string[]; account?: DiscordSourceAccount }>
  scan: (selection: ImportSelection) => Promise<ImportInventory>
  collect: (selection: ImportSelection) => Promise<Uint8Array>
  cancel: () => Promise<void>
  disconnect: () => Promise<void>
  verifyAccount?: (input: { riparlare_access_token: string; expected_discord_id: string; accepted_server_verification: true }) => Promise<{ discord_id: string; username: string; linked: true }>
  onProgress: (callback: (event: CollectorProgress) => void) => () => void
}

function desktopBridge(): DesktopMigrationBridge | undefined {
  const electron = window.electronAPI as (typeof window.electronAPI & { discordMigration?: DesktopMigrationBridge })
  return electron?.discordMigration
}

const doneStatus = (status: string) => ['completed', 'done', 'committed'].includes(status)
const activeStatus = (status: string) => ['running', 'importing', 'queued', 'committing', 'processing'].includes(status)
const phaseLabels = { discovery: 'Kanallar inceleniyor', messages: 'Mesajlar okunuyor', media: 'Ekler hazırlanıyor', packing: 'Aktarım hazırlanıyor' }
const steps = ['Kaynak', 'İçerik seçimi', 'Önizleme', 'Aktarım']
const retainSourceWarnings = (data: ImportInventory, warnings: string[] = []): ImportInventory => (
  { ...data, warnings: [...new Set([...warnings, ...(data.warnings ?? [])])] }
)

export default function DiscordImportWizard({ onClose }: { onClose?: () => void }) {
  const { t } = useTranslation()
  const ownUsername = useAuthStore(state => state.user?.discriminator)
  const bridge = desktopBridge()
  const [step, setStep] = useState(0)
  const [inventory, setInventory] = useState<ImportInventory | null>(null)
  const [selection, setSelection] = useState<ImportSelection | null>(null)
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [previewFingerprint, setPreviewFingerprint] = useState('')
  const [jobs, setJobs] = useState<ImportInventory[]>([])
  const [sourceMode, setSourceMode] = useState<'archive' | 'desktop'>('archive')
  const [desktopSource, setDesktopSource] = useState(false)
  const [desktopScanned, setDesktopScanned] = useState(false)
  const [token, setToken] = useState('')
  const [acceptedRisk, setAcceptedRisk] = useState(false)
  const [serverVerificationConsent, setServerVerificationConsent] = useState(false)
  const [linkResult, setLinkResult] = useState<{ discordId: string; status: 'verified' | 'failed' } | null>(null)
  const [adoptSourceUsername, setAdoptSourceUsername] = useState(false)
  const [usernameResult, setUsernameResult] = useState<UsernameAdoption | 'saving' | null>(null)
  const [busy, setBusy] = useState<'upload' | 'connect' | 'inspect' | 'scan' | 'collect' | 'preview' | 'commit' | 'resume' | null>(null)
  const [loadingGuildId, setLoadingGuildId] = useState<string | null>(null)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [preparedUpload, setPreparedUpload] = useState<{ file: File; fingerprint: string } | null>(null)
  const [collectorProgress, setCollectorProgress] = useState<CollectorProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const uploadController = useRef<AbortController | null>(null)
  const requestSerial = useRef(0)
  const selectionRevision = useRef(0)
  const mounted = useRef(true)
  const currentFingerprint = useMemo(() => inventory && selection ? selectionFingerprint(selection, inventory) : '', [inventory, selection])
  const validPreview = Boolean(preview && previewFingerprint === currentFingerprint)
  const canonical = useMemo(() => inventory && selection ? canonicalSelection(selection, inventory) : null, [inventory, selection])
  const dateError = selection ? selectionDateError(selection) : null
  const limitError = canonical ? selectionLimitError(canonical) : null
  const selectedCount = canonical?.channel_ids.length ?? 0
  const unloadedSelectedGuild = inventory?.guilds.some(guild => guild.channels_loaded === false && canonical?.guild_ids.includes(guild.id)) ?? false
  const working = !!busy || Boolean(inventory && activeStatus(inventory.status))

  useEffect(() => {
    mounted.current = true
    const controller = new AbortController()
    discordMigrationApi.list(controller.signal).then(data => setJobs(data ?? [])).catch(() => { /* The upload path reports availability errors on actual use. */ })
    return () => {
      mounted.current = false
      requestSerial.current++
      controller.abort()
      uploadController.current?.abort()
      void bridge?.disconnect().catch(() => undefined)
    }
  // The bridge object is stable for an app session; do not reconnect on render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => bridge?.onProgress(progress => { if (mounted.current) setCollectorProgress(progress) }), [bridge])

  useEffect(() => {
    if (!inventory || !activeStatus(inventory.status)) return
    const controller = new AbortController()
    const timer = window.setInterval(() => {
      discordMigrationApi.get(inventory.id, controller.signal).then(updated => {
        if (!mounted.current || controller.signal.aborted) return
        setInventory(current => current?.id === updated.id ? retainSourceWarnings(updated, current.warnings) : current)
        if (updated.error && !doneStatus(updated.status)) setError('Aktarım tamamlanamadı. Ayrıntıları inceleyip aynı aktarımı yeniden deneyebilirsin.')
      }).catch(() => {
        if (mounted.current && !controller.signal.aborted) setError('Aktarım durumu alınamadı. Bağlantını kontrol edip durumu yenile; yeni bir aktarım başlatmana gerek yok.')
      })
    }, 1800)
    return () => { controller.abort(); window.clearInterval(timer) }
  }, [inventory?.id, inventory?.status])

  useEffect(() => { setConfirmed(false) }, [currentFingerprint])

  function changeSelection(value: ImportSelection | ((previous: ImportSelection) => ImportSelection)) {
    setPreparedUpload(null)
    selectionRevision.current++
    setSelection(previous => previous ? typeof value === 'function' ? value(previous) : value : previous)
    setError(null)
    setConfirmed(false)
    setAdoptSourceUsername(false)
    setUsernameResult(null)
  }
  function useInventory(data: ImportInventory, previous?: ImportSelection) {
    setPreparedUpload(null)
    setInventory(data)
    setSelection(previous ? canonicalSelection({ ...emptySelection(data), ...previous }, data) : data.selection ?? emptySelection(data))
    setFocusedId(data.channels[0]?.id ?? null)
    setPreview(null)
    setPreviewFingerprint('')
    setDesktopSource(false)
    setDesktopScanned(false)
    setLoadingGuildId(null)
    setConfirmed(false)
    setAdoptSourceUsername(false)
    setUsernameResult(null)
    setStep(doneStatus(data.status) || activeStatus(data.status) ? 3 : 1)
  }
  async function upload(file: File, previous?: ImportSelection, previewAfterUpload = false) {
    if (file.size > 64 * 1024 * 1024) { setError('Arşiv 64 MB sınırını aşıyor. Daha az kanal seçerek ayrı aktarımlar oluştur.'); return }
    if (!file.name.toLowerCase().endsWith('.zip')) { setError('Bir ZIP aktarım arşivi seç.'); return }
    const serial = ++requestSerial.current
    const controller = new AbortController()
    uploadController.current = controller
    setBusy('upload'); setError(null); setUploadProgress(0)
    let accepted = false
    try {
      const uploaded = await discordMigrationApi.upload(file, controller.signal, percent => { if (serial === requestSerial.current) setUploadProgress(percent) })
      accepted = true
      // Local scan failures can be absent from normalized server inventory. Keep
      // those explicit caveats when replacing local inventory with its ZIP job.
      const data = retainSourceWarnings(uploaded, previewAfterUpload ? inventory?.warnings : [])
      if (mounted.current && serial === requestSerial.current) {
        if (previewAfterUpload) void bridge?.disconnect().catch(() => undefined)
        useInventory(data, previous)
        // An idempotent upload can return the existing committed/running job.
        // Keep its destination/progress screen; never restart preview or commit.
        if (doneStatus(data.status) || activeStatus(data.status)) return
        if (previewAfterUpload && previous) {
          // Excluded source authors/channels have already been removed on-device.
          // Canonicalize against the filtered archive rather than sending stale IDs.
          const request = canonicalSelection({ ...emptySelection(data), ...previous }, data)
          setBusy('preview')
          const result = await discordMigrationApi.preview(data.id, request, controller.signal)
          if (mounted.current && serial === requestSerial.current) {
            setSelection(request); setPreview(result)
            setPreviewFingerprint(selectionFingerprint(request, data)); setConfirmed(false); setStep(2)
          }
        }
      }
    } catch (failure) {
      if (mounted.current && !controller.signal.aborted && serial === requestSerial.current) {
        if (!accepted && rejectedImportSnapshot(failure)) setPreparedUpload(null)
        setError(accepted ? apiErrorMessage(failure, t, 'Önizleme hazırlanamadı. Arşivin sunucuda kayıtlı; seçimini yeniden inceleyebilirsin.') : previewAfterUpload ? importUploadErrorMessage(failure) : apiErrorMessage(failure, t, 'Arşiv yüklenemedi. ZIP dosyanı yeniden seçerek tekrar deneyebilirsin.'))
      }
    } finally {
      if (mounted.current && serial === requestSerial.current) setBusy(null)
      if (uploadController.current === controller) uploadController.current = null
    }
  }
  async function connect() {
    if (!bridge || !token.trim() || !acceptedRisk) return
    const serial = ++requestSerial.current
    const credential = token.trim()
    setToken('')
    setBusy('connect'); setError(null); setCollectorProgress(null)
    try {
      const data = await bridge.connect({ token: credential, acceptedRisk: true })
      if (!mounted.current || serial !== requestSerial.current) return
      const source = normalizeInventory({ ...data, id: 'device-source', source_hash: '', status: 'source', authors: [] })
      setInventory(source); setSelection(emptySelection(source)); setFocusedId(source.channels[0]?.id ?? null)
      setDesktopSource(true); setDesktopScanned(false); setStep(1)
      setLinkResult(null)
      if (serverVerificationConsent && bridge.verifyAccount && data.account?.id) {
        const accessToken = useAuthStore.getState().token
        if (accessToken) {
          try {
            const linked = await bridge.verifyAccount({ riparlare_access_token: accessToken,
              expected_discord_id: data.account.id, accepted_server_verification: true })
            if (mounted.current && serial === requestSerial.current) setLinkResult({ discordId: data.account.id,
              status: linked.linked && linked.discord_id === data.account.id ? 'verified' : 'failed' })
          } catch { if (mounted.current && serial === requestSerial.current) setLinkResult({ discordId: data.account.id, status: 'failed' }) }
        } else setLinkResult({ discordId: data.account.id, status: 'failed' })
      }
    } catch (failure) {
      if (mounted.current && serial === requestSerial.current) setError(collectorErrorMessage(failure, 'Discord bağlantısı kurulamadı. Erişimini ve kimlik bilgisini kontrol et. Kimlik bilgisini hata raporuna ekleme.'))
    } finally { if (mounted.current && serial === requestSerial.current) setBusy(null) }
  }
  async function collect() {
    if (!bridge || !canonical || unloadedSelectedGuild || limitError) return
    const serial = ++requestSerial.current
    setBusy('collect'); setError(null); setCollectorProgress(null)
    try {
      if (preparedUpload?.fingerprint === currentFingerprint) {
        await upload(preparedUpload.file, canonical, true)
        return
      }
      const data = await bridge.collect(canonical)
      if (!mounted.current || serial !== requestSerial.current) return
      // Copy the bridge bytes into an owned ArrayBuffer, avoiding SharedArrayBuffer/File typing issues.
      const buffer = new ArrayBuffer(data.byteLength)
      new Uint8Array(buffer).set(data)
      const file = new File([buffer], 'discord-aktarim.zip', { type: 'application/zip' })
      setPreparedUpload({ file, fingerprint: currentFingerprint })
      await upload(file, canonical, true)
    } catch (failure) {
      if (mounted.current && serial === requestSerial.current) setError(collectorErrorMessage(failure, 'Seçili içerik hazırlanamadı; seçimlerin korundu. Daha az kanal veya ek seçip yeniden deneyebilirsin. Kaynak bağlantısı kesildiyse kaynağı değiştirip yeniden bağlan.'))
    } finally { if (mounted.current && serial === requestSerial.current) setBusy(null) }
  }
  async function inspectGuild(guildId: string, selectAll: boolean) {
    if (!inventory || !selection || busy) return
    const guild = inventory.guilds.find(item => item.id === guildId)
    if (!guild || guild.channels_loaded !== false) return
    if (!bridge?.inspectGuild) { setError('Sunucu kanallarını yüklemek için masaüstü uygulamasını güncelle.'); return }
    const serial = ++requestSerial.current
    const sourceId = inventory.id
    if (selectAll) changeSelection(previous => ({ ...previous, guild_ids: [...new Set([...previous.guild_ids, guildId])] }))
    setLoadingGuildId(guildId); setBusy('inspect'); setError(null); setCollectorProgress(null)
    try {
      const raw = await bridge.inspectGuild(guildId)
      if (!mounted.current || serial !== requestSerial.current) return
      const updated = normalizeInventory({ ...inventory, ...raw, id: sourceId, status: inventory.status, source_hash: inventory.source_hash })
      const loaded = updated.guilds.find(item => item.id === guildId)
      if (!loaded || loaded.channels_loaded !== true) throw new Error('Guild inspection incomplete')
      setInventory(current => current && current.id === sourceId
        ? normalizeInventory({ ...current, ...raw, id: current.id, status: current.status, source_hash: current.source_hash, authors: current.authors }) : current)
      setSelection(previous => {
        if (!previous) return previous
        const next = { ...previous, role_ids: { ...previous.role_ids,
          [guildId]: loaded.roles.filter(role => !role.managed).map(role => role.id) } }
        // A user may clear the pending guild while its channels load. Never
        // resurrect that selection or overwrite unrelated DM/channel changes.
        return selectAll && previous.guild_ids.includes(guildId)
          ? toggleChannels(next, updated, updated.channels.filter(channel => channel.guild_id === guildId).map(channel => channel.id), true)
          : next
      })
      setFocusedId(previous => previous ?? updated.channels.find(channel => channel.guild_id === guildId)?.id ?? null)
      setDesktopScanned(false); setPreview(null); setPreviewFingerprint(''); setConfirmed(false)
    } catch (failure) {
      if (mounted.current && serial === requestSerial.current) {
        setError(collectorErrorMessage(failure, `${guild.name} sunucusunun kanalları alınamadı. Yeniden deneyebilirsin; diğer seçimlerin korundu.`))
        if (selectAll) setSelection(previous => previous ? { ...previous, guild_ids: previous.guild_ids.filter(id => id !== guildId) } : previous)
      }
    } finally {
      if (mounted.current && serial === requestSerial.current) { setBusy(null); setLoadingGuildId(null) }
    }
  }
  async function selectAllSources() {
    if (!inventory || !selection || busy) return
    const upfrontLimit = selectionLimitError({ channel_ids: inventory.channels.map(channel => channel.id), guild_ids: inventory.guilds.map(guild => guild.id) })
    if (upfrontLimit) { setError(upfrontLimit); return }
    const unloaded = inventory.guilds.filter(guild => guild.channels_loaded === false)
    if (!unloaded.length) {
      changeSelection(previous => ({ ...toggleChannels(previous, inventory, inventory.channels.map(channel => channel.id), true), guild_ids: inventory.guilds.map(guild => guild.id) }))
      return
    }
    if (!bridge?.inspectGuild) { setError('Tüm sunucuların kanallarını yüklemek için masaüstü uygulamasını güncelle.'); return }
    const serial = ++requestSerial.current
    const startingSelectionRevision = selectionRevision.current
    let updated = inventory
    const failed: string[] = []
    let firstSafeFailure = ''
    setBusy('inspect'); setError(null); setCollectorProgress(null)
    try {
      for (const guild of unloaded) {
        if (!mounted.current || serial !== requestSerial.current) return
        setLoadingGuildId(guild.id); setCollectorProgress(null)
        let raw: Awaited<ReturnType<NonNullable<DesktopMigrationBridge['inspectGuild']>>>
        try { raw = await bridge.inspectGuild(guild.id) }
        catch (failure) {
          if (!mounted.current || serial !== requestSerial.current) return
          failed.push(guild.name); firstSafeFailure ||= collectorErrorMessage(failure, '')
          continue
        }
        if (!mounted.current || serial !== requestSerial.current) return
        const candidate = normalizeInventory({ ...updated, ...raw, id: inventory.id, status: inventory.status, source_hash: inventory.source_hash })
        const loaded = candidate.guilds.find(item => item.id === guild.id)
        if (!loaded || loaded.channels_loaded !== true) { failed.push(guild.name); continue }
        updated = candidate
        setInventory(updated)
        // Retain useful metadata/default roles even if a later guild hits a limit.
        // Channel/guild selections remain unchanged until the whole request fits.
        const defaultRoles = loaded.roles.filter(role => !role.managed).map(role => role.id)
        setSelection(previous => previous ? { ...previous, role_ids: { ...previous.role_ids, [guild.id]: defaultRoles } } : previous)
        const exceeded = selectionLimitError({ channel_ids: updated.channels.map(channel => channel.id), guild_ids: updated.guilds.map(item => item.id) })
        if (exceeded) { setError(exceeded); return }
      }
      const loadedIds = updated.guilds.filter(guild => guild.channels_loaded !== false).map(guild => guild.id)
      const loaded = new Set(loadedIds)
      const channelIds = updated.channels.filter(channel => !channel.guild_id || loaded.has(channel.guild_id)).map(channel => channel.id)
      const exceeded = selectionLimitError({ channel_ids: channelIds, guild_ids: loadedIds })
      if (exceeded) { setError(exceeded); return }
      if (selectionRevision.current !== startingSelectionRevision) {
        setError('Sunucular yüklendi. Yükleme sırasında seçimlerini değiştirdiğin için tümünü otomatik seçmedim; son seçimlerin korundu.')
        return
      }
      changeSelection(previous => ({ ...toggleChannels(previous, updated, channelIds, true), guild_ids: loadedIds }))
      setDesktopScanned(false); setPreview(null); setPreviewFingerprint('')
      if (failed.length) setError(`${failed.length} sunucunun kanalları alınamadı (${failed.slice(0, 3).join(', ')}). Yüklenebilen kaynaklar seçildi; eksik sunucuları yeniden açabilirsin.${firstSafeFailure ? ` ${firstSafeFailure}` : ''}`)
    } catch (failure) {
      if (mounted.current && serial === requestSerial.current) setError(collectorErrorMessage(failure, 'Tüm kaynaklar seçilemedi. Önceki seçimlerin korundu; yüklenen sunucuları tek tek seçebilirsin.'))
    } finally {
      if (mounted.current && serial === requestSerial.current) { setBusy(null); setLoadingGuildId(null) }
    }
  }
  async function scan() {
    if (!bridge?.scan || !canonical || unloadedSelectedGuild || limitError) return
    const serial = ++requestSerial.current
    setBusy('scan'); setError(null); setCollectorProgress(null)
    try {
      const data = normalizeInventory(await bridge.scan(canonical))
      if (!mounted.current || serial !== requestSerial.current) return
      setInventory(data)
      setSelection(canonicalSelection({ ...emptySelection(data), ...canonical }, data))
      setDesktopSource(true); setDesktopScanned(true)
      setFocusedId(data.channels.find(channel => canonical.channel_ids.includes(channel.id))?.id ?? data.channels[0]?.id ?? null)
      setPreview(null); setPreviewFingerprint(''); setConfirmed(false)
    } catch (failure) {
      if (mounted.current && serial === requestSerial.current) setError(collectorErrorMessage(failure, 'Seçili kanallar cihazında incelenemedi. Erişimini kontrol edip yeniden deneyebilirsin; hiçbir içerik Riparlare’ye gönderilmedi.'))
    } finally { if (mounted.current && serial === requestSerial.current) setBusy(null) }
  }
  async function makePreview() {
    if (!inventory || !canonical || dateError || desktopSource || unloadedSelectedGuild || limitError) return
    const fingerprint = currentFingerprint
    setBusy('preview'); setError(null)
    try {
      const data = await discordMigrationApi.preview(inventory.id, canonical)
      if (!mounted.current) return
      setPreview(data); setPreviewFingerprint(fingerprint); setConfirmed(false); setStep(2)
    } catch (failure) { if (mounted.current) setError(apiErrorMessage(failure, t, 'Seçimler incelenemedi. Kanal ve tarih seçimlerini kontrol et.')) }
    finally { if (mounted.current) setBusy(null) }
  }
  async function commit() {
    if (!inventory || !canonical || !preview || !validPreview || !confirmed) return
    setBusy('commit'); setError(null)
    try {
      const committed = await discordMigrationApi.commit(inventory.id, canonical, preview.selection_hash)
      const data = retainSourceWarnings(committed, inventory.warnings)
      if (!mounted.current) return
      setInventory(data); setStep(3)
      setJobs(previous => [data, ...previous.filter(job => job.id !== data.id)])
      if (adoptSourceUsername && inventory.account?.username) {
        const username = inventory.account.username.trim()
        const currentId = useAuthStore.getState().user?.id
        setUsernameResult('saving')
        // Explicit independent profile choice: apply after the server accepts the
        // import request, including queued jobs; never gate or roll back that job.
        let outcome: UsernameAdoption = 'failed'
        try { outcome = await discordMigrationApi.adoptUsername(username) } catch { /* Non-fatal by design. */ }
        if (!mounted.current) return
        setUsernameResult(outcome)
        if (outcome === 'updated') {
          const state = useAuthStore.getState()
          if (state.user && state.user.id === currentId) {
            state.setUser({ ...state.user, discriminator: username })
            queryClient.setQueryData<DtoUser>(['settings-user-me'], cached => cached && String(cached.id) === String(currentId) ? { ...cached, discriminator: username } : cached)
          }
        }
      }
    } catch (failure) { if (mounted.current) setError(apiErrorMessage(failure, t, 'Aktarım başlatılamadı. Seçimler değiştiyse önizlemeyi yenile.')) }
    finally { if (mounted.current) setBusy(null) }
  }
  async function resume(id: string) {
    setBusy('resume'); setError(null)
    try { const data = await discordMigrationApi.get(id); if (mounted.current) useInventory(data) }
    catch (failure) { if (mounted.current) setError(apiErrorMessage(failure, t, 'Bu aktarım açılamadı.')) }
    finally { if (mounted.current) setBusy(null) }
  }
  async function cancelSource() {
    setPreparedUpload(null)
    uploadController.current?.abort()
    requestSerial.current++
    await bridge?.cancel().catch(() => undefined)
    if (mounted.current) { setBusy(null); setLoadingGuildId(null); setError('Hazırlama durduruldu. Devam etmek için kaynağı değiştirip yeniden bağlan. Riparlare’de yeni bir sunucu veya sohbet oluşturulmadı.'); setCollectorProgress(null) }
  }
  async function resetSource() {
    requestSerial.current++
    await bridge?.disconnect().catch(() => undefined)
    setToken(''); setInventory(null); setSelection(null); setDesktopSource(false); setDesktopScanned(false); setLoadingGuildId(null); setPreview(null); setStep(0); setError(null)
    setLinkResult(null); setAdoptSourceUsername(false); setUsernameResult(null); setServerVerificationConsent(false)
  }
  const sourceBanner = desktopSource
    ? desktopScanned
      ? 'Seçili geçmiş şu anda yalnızca cihazında. Hariç tutacağın kişileri, tarihleri ve ek türlerini seç; bu içerikler ayıklanmadan Riparlare’ye gönderilmez.'
      : 'Önce kanalları seç. Seçili geçmiş yalnızca cihazında incelenecek; ardından kişileri ve tarihleri ayıklayıp Riparlare’ye göndereceksin.'
    : 'Hiçbir karşı hesap otomatik eklenmez. Aktarılan geçmiş yalnızca sana görünür; yeni mesajlar için normal kanal izinleri geçerlidir.'
  const loadingGuildName = collectorProgress?.guild_name || inventory?.guilds.find(guild => guild.id === loadingGuildId)?.name
  const waitingText = (collectorProgress?.waiting_ms ?? 0) > 0
    ? ` · Discord sınırı nedeniyle ${Math.ceil((collectorProgress?.waiting_ms ?? 0) / 1000)} sn bekleniyor` : ''
  const discoveryProgress = busy === 'inspect'
    ? `${loadingGuildName || 'Seçili sunucu'} kanalları yükleniyor${waitingText}`
    : `Sunucu listesi hazırlanıyor${collectorProgress?.guilds_discovered !== undefined ? ` · ${collectorProgress.guilds_discovered} sunucu bulundu` : ''}${waitingText}`

  return <div className="flex h-full min-h-0 flex-col bg-background text-foreground" data-testid="discord-import-wizard">
    <header className="flex shrink-0 items-start gap-3 border-b px-5 py-5 sm:px-8">
      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-muted"><FolderInput className="h-6 w-6" /></div>
      <div className="min-w-0 flex-1"><h1 className="text-xl font-semibold">Discord’dan Riparlare’ye</h1><p className="mt-1 text-sm text-muted-foreground">Sohbetlerini getir. Nelerin geleceğine sen karar ver.</p></div>
      {onClose && <button type="button" onClick={onClose} aria-label="Aktarım ekranını kapat" className="rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-foreground"><X className="h-5 w-5" /></button>}
    </header>
    <ol className="flex shrink-0 gap-5 overflow-x-auto border-b px-5 py-3 sm:px-8" aria-label="Aktarım aşamaları">{steps.map((label, index) => <li key={label} className={cn('flex items-center gap-2 whitespace-nowrap text-sm', index === step ? 'font-semibold' : 'text-muted-foreground')} aria-current={index === step ? 'step' : undefined}><span className={cn('flex h-6 w-6 items-center justify-center rounded-full text-xs', index < step ? 'bg-foreground text-background' : index === step ? 'border border-foreground' : 'border')}>{index < step ? <Check className="h-3.5 w-3.5" /> : index + 1}</span>{label}</li>)}</ol>
    {error && <div role="alert" className="mx-5 mt-4 flex shrink-0 items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm sm:mx-8"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" /><span className="flex-1 leading-relaxed">{error}</span><button type="button" onClick={() => setError(null)} aria-label="Hata mesajını kapat"><X className="h-4 w-4" /></button></div>}

    {step === 0 && <main className="min-h-0 flex-1 overflow-y-auto px-5 py-7 sm:px-8">
      <div className="mx-auto max-w-3xl">
        <h2 className="text-2xl font-semibold">Nereden başlayalım?</h2><p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">Hazır arşivini seç veya masaüstü uygulamasında Discord’a bağlan. Sunucu ve sohbet seçimi sonraki adımda.</p>
        <div className="mb-6 mt-6 flex gap-1 rounded-lg bg-muted p-1" role="tablist" aria-label="Aktarım kaynağı"><button type="button" role="tab" aria-selected={sourceMode === 'archive'} onClick={() => setSourceMode('archive')} className={cn('flex-1 rounded-md px-3 py-2 text-sm', sourceMode === 'archive' && 'bg-popover shadow-sm')}>Arşivden aktar</button><button type="button" role="tab" aria-selected={sourceMode === 'desktop'} onClick={() => setSourceMode('desktop')} className={cn('flex-1 rounded-md px-3 py-2 text-sm', sourceMode === 'desktop' && 'bg-popover shadow-sm')}>Discord’dan seç</button></div>
        {sourceMode === 'archive' ? <section className="rounded-xl border border-dashed p-7 sm:p-9">
          <FileArchive className="h-9 w-9 text-muted-foreground" /><h3 className="mt-4 text-lg font-semibold">Aktarım arşivini seç</h3><p className="mt-2 text-sm leading-relaxed text-muted-foreground">Riparlare aktarım aracının oluşturduğu ZIP arşivi veya Discord veri paketi. Discord’un kendi paketi yalnızca senin gönderdiğin mesajları içerebilir.</p><p className="mt-2 text-xs text-muted-foreground">En fazla 64 MB. Seçim yapmadan hiçbir sunucu oluşturulmaz.</p>
          <input ref={fileInput} type="file" accept=".zip,application/zip" className="hidden" aria-label="Discord ZIP arşivi seç" onChange={event => { const file = event.target.files?.[0]; if (file) void upload(file); event.target.value = '' }} />
          <button type="button" disabled={!!busy} onClick={() => fileInput.current?.click()} className="mt-6 inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground disabled:opacity-50">{busy === 'upload' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}{busy === 'upload' ? (uploadProgress >= 100 ? 'Arşiv sunucuda doğrulanıyor…' : `Arşiv gönderiliyor · %${uploadProgress}`) : 'ZIP arşivi seç'}</button>
        </section> : <section className="space-y-4">
          {!bridge ? <div className="rounded-lg border p-5"><h3 className="font-semibold">Masaüstü uygulamasında kullanılabilir</h3><p className="mt-2 text-sm leading-relaxed text-muted-foreground">Discord bağlantısı cihazında çalışır. Güncel Windows uygulamasını açabilir veya hazırladığın ZIP arşivini bu ekrandan seçebilirsin.</p><Link to="/indir" className="mt-4 inline-block text-sm underline underline-offset-4">Masaüstü uygulamasını indir</Link></div> : <>
            <div className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-sm leading-relaxed"><AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" /><p>Discord, kullanıcı hesabıyla otomatik veri okumayı yasaklıyor ve hesabına yaptırım uygulayabilir. Bu riski kabul etmek Discord kurallarını değiştirmez. Yalnızca kendi hesabınla erişebildiğin içeriği seç.</p></div>
            <label className="flex items-start gap-3 text-sm"><input type="checkbox" checked={acceptedRisk} onChange={event => setAcceptedRisk(event.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-white" /><span>Kendi hesabımı kullanıyorum ve Discord hesabıma uygulanabilecek yaptırım riskini kabul ediyorum.</span></label>
            {bridge.verifyAccount && <label className="flex items-start gap-3 rounded-lg border p-4 text-sm leading-relaxed"><input type="checkbox" checked={serverVerificationConsent} onChange={event => setServerVerificationConsent(event.target.checked)} disabled={!!busy} className="mt-1 h-4 w-4 shrink-0 accent-white" /><span><span className="block font-medium">Discord hesabımı bağla (isteğe bağlı)</span><span className="mt-1 block text-xs text-muted-foreground">Hesap doğrulaması için tokenin Riparlare sunucusuna bir kez gönderilmesini kabul ediyorum. Sunucu Discord kimliğimi doğrular ve tokeni kaydetmez. Bu kutuyu seçmezsem aktarım cihazımda hazırlanır, tokenim Riparlare’ye gönderilmez.</span></span></label>}
            <label className="block text-sm font-medium">Discord hesap tokeni<input type="password" autoComplete="off" autoCorrect="off" spellCheck={false} value={token} onChange={event => setToken(event.target.value)} disabled={!acceptedRisk || !!busy} className="mt-2 block w-full rounded-md border bg-popover px-3 py-2.5 outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50" /></label><p className="text-xs leading-relaxed text-muted-foreground">Standart aktarımda token yalnızca cihazında kullanılır ve kaydedilmez. Yalnızca yukarıdaki ayrı hesap doğrulamasını seçersen sunucuya bir kez gönderilir. Tokeni sohbet veya hata raporunda paylaşma.</p>
            <button type="button" disabled={!acceptedRisk || !token.trim() || !!busy} onClick={() => void connect()} className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground disabled:opacity-50">{busy === 'connect' ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}{busy === 'connect' ? 'Kaynaklar inceleniyor' : 'Bağlan ve kaynakları göster'}</button>
          </>}
        </section>}
        {jobs.length > 0 && <section className="mt-9"><h3 className="mb-3 text-sm font-semibold">Önceki aktarımların</h3><div className="divide-y rounded-lg border">{jobs.slice(0, 15).map(job => <button key={job.id} type="button" disabled={!!busy} onClick={() => void resume(job.id)} className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm hover:bg-accent disabled:opacity-50"><FileArchive className="h-4 w-4 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1 truncate">{job.guilds?.[0]?.name ?? `Discord aktarımı ${job.id.slice(0, 8)}`}</span><span className="text-xs text-muted-foreground">{doneStatus(job.status) ? 'Tamamlandı' : activeStatus(job.status) ? 'Devam ediyor' : job.status === 'failed' ? 'Tekrar incelenebilir' : 'Seçim bekliyor'}</span><ArrowRight className="h-4 w-4 text-muted-foreground" /></button>)}</div></section>}
      </div>
    </main>}

    {step === 1 && inventory && selection && <>
      <p className="shrink-0 border-b bg-muted/30 px-5 py-3 text-xs leading-relaxed text-muted-foreground sm:px-8">{sourceBanner}</p>
      {linkResult && linkResult.discordId === inventory.account?.id && <p role="status" className="shrink-0 border-b px-5 py-3 text-xs leading-relaxed sm:px-8">{linkResult.status === 'verified' ? 'Discord hesabın doğrulanmış kimliğiyle bağlandı. Kullanıcı adlarının aynı olması gerekmiyor; özel geçmiş erişimi değişmez.' : 'Discord hesabı bağlanamadı. Bu durum aktarımı engellemez; içerik seçimine devam edebilirsin.'}</p>}
      <main className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto md:grid-cols-[minmax(260px,35%)_1fr] md:overflow-hidden"><div className="h-80 border-b md:h-auto md:min-h-0 md:border-b-0 md:border-r"><SourceTree inventory={inventory} selection={selection} onChange={changeSelection} focusedId={focusedId} onFocus={setFocusedId} onInspectGuild={desktopSource ? (id, selectAll) => void inspectGuild(id, selectAll) : undefined} onSelectAll={() => void selectAllSources()} loadingGuildId={loadingGuildId} inspectionDisabled={!!busy} /></div><ImportOptions inventory={inventory} selection={selection} onChange={changeSelection} focusedId={focusedId} /></main>
    </>}

    {step === 2 && inventory && preview && <main className="min-h-0 flex-1 overflow-y-auto px-5 py-7 sm:px-8"><div className="mx-auto max-w-3xl"><h2 className="text-2xl font-semibold">Seçtiklerin böyle gelecek</h2><p className="mt-2 text-sm leading-relaxed text-muted-foreground">Bu önizleme sunucuda seçimlerine göre hesaplandı. Aktarılan geçmiş yalnızca sana görünür. Karşı hesaplar oluşturulmaz veya gruplara otomatik eklenmez.</p><dl className="mt-7 grid grid-cols-2 gap-x-6 gap-y-5 border-y py-5 sm:grid-cols-4">{([['Kanal', preview.counts.channels], ['Mesaj', preview.counts.messages], ['Ek', preview.counts.media], ['Hariç mesaj', preview.counts.excluded_messages]] as const).map(([label, value]) => <div key={label}><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 text-2xl font-semibold tabular-nums">{value.toLocaleString('tr-TR')}</dd></div>)}</dl>
      <div className="mt-6 space-y-3 text-sm"><p><span className="text-muted-foreground">Sunucular: </span>{inventory.guilds.filter(guild => canonical?.guild_ids.includes(guild.id)).map(guild => guild.name).join(', ') || 'Seçili özel / grup sohbetleri'}</p><p><span className="text-muted-foreground">Hariç tutulan kişiler: </span>{selection?.excluded_author_ids.length ?? 0} tüm aktarımda, {Object.values(selection?.channel_excluded_author_ids ?? {}).reduce((sum, ids) => sum + ids.length, 0)} kanal bazında</p><p><span className="text-muted-foreground">Mesaj aralığı: </span>{canonical?.after ? new Date(canonical.after).toLocaleString() : 'Başlangıçtan'} — {canonical?.before ? new Date(canonical.before).toLocaleString() : 'Sonuna kadar'}</p></div>
      <section className="mt-6 rounded-lg border p-4"><h3 className="text-sm font-semibold">Kullanıcı adını sen seç</h3><p className="mt-2 text-sm leading-relaxed text-muted-foreground">Riparlare ve Discord kullanıcı adlarının aynı olması gerekmez. {ownUsername ? `Riparlare’de @${ownUsername} olarak kalabilirsin.` : 'Mevcut Riparlare kullanıcı adın korunur.'}</p>{inventory.account?.username && <label className="mt-4 flex items-start gap-3 text-sm leading-relaxed"><input type="checkbox" checked={adoptSourceUsername} onChange={event => setAdoptSourceUsername(event.target.checked)} disabled={!!busy} className="mt-1 h-4 w-4 shrink-0 accent-white" /><span>Discord’daki <strong>@{inventory.account.username}</strong> kullanıcı adını Riparlare’de de kullanmak istiyorum.<span className="mt-1 block text-xs text-muted-foreground">Yalnızca bu kutuyu seçersen, aktarım isteği kabul edildiğinde kullanıcı adı değişikliği ayrı olarak uygulanır. Ad alınmışsa mevcut adın korunur ve aktarım devam eder. Bu seçim Discord hesabının sahipliğini doğrulamaz.</span></span></label>}</section>
      {[...new Set([...inventory.warnings, ...preview.warnings])].length > 0 && <section className="mt-6 rounded-lg border border-amber-500/25 bg-amber-500/5 p-4"><h3 className="flex items-center gap-2 text-sm font-semibold"><AlertTriangle className="h-4 w-4 text-amber-400" />Aktarmadan önce bilmen gerekenler</h3><ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-relaxed text-muted-foreground">{[...new Set([...inventory.warnings, ...preview.warnings])].slice(0, 80).map((warning, index) => <li key={`${index}-${warning}`}>{importWarningText(warning)}</li>)}</ul></section>}
      {!validPreview && <p role="alert" className="mt-5 text-sm text-amber-400">Seçimler değişti. Aktarmadan önce önizlemeyi yenile.</p>}
      <label className="mt-7 flex items-start gap-3 rounded-lg border p-4 text-sm leading-relaxed"><input type="checkbox" checked={confirmed} disabled={!validPreview || !!busy} onChange={event => setConfirmed(event.target.checked)} className="mt-1 h-4 w-4 shrink-0 accent-white" /><span>Seçimleri ve eksikleri inceledim. Seçili içeriklerden yeni sunucu ve sohbetler oluşturulsun. Mevcut sohbetlerim değiştirilmesin.</span></label></div></main>}

    {step === 3 && inventory && <main className="min-h-0 flex-1 overflow-y-auto px-5 py-8 sm:px-8"><div className="mx-auto max-w-3xl"><div className="flex items-center gap-4">{doneStatus(inventory.status) ? <CheckCircle2 className="h-10 w-10 text-emerald-400" /> : activeStatus(inventory.status) ? <Loader2 className="h-10 w-10 animate-spin text-muted-foreground" /> : <AlertTriangle className="h-10 w-10 text-amber-400" />}<div><h2 className="text-2xl font-semibold">{doneStatus(inventory.status) ? 'Seçtiklerin Riparlare’de' : activeStatus(inventory.status) ? 'İçerik aktarılıyor' : 'Aktarım durumu'}</h2><p className="mt-1 text-sm text-muted-foreground">{doneStatus(inventory.status) ? 'Aşağıdaki bağlantılardan oluşturulan sohbetleri açabilirsin.' : 'Bu ekranı kapatsan da sunucuda başlayan işlem durumunu buradan yeniden açabilirsin.'}</p></div></div>
      {inventory.progress && <div className="mt-6"><div className="mb-2 flex justify-between text-sm"><span>{inventory.progress.stage || 'Hazırlanıyor'}</span><span>{inventory.progress.completed ?? 0} / {inventory.progress.total ?? '?'}</span></div>{!!inventory.progress.total && <progress value={inventory.progress.completed ?? 0} max={inventory.progress.total} className="h-2 w-full accent-white" />}</div>}
      <p className="mt-6 rounded-lg bg-muted/50 p-4 text-sm leading-relaxed text-muted-foreground">Eski mesajlar Discord kaynağı ve kaynak tarihiyle işaretlenir. Hesap sahiplenme, başka birinin özel geçmişine erişim sağlamaz. Aktarılan geçmiş yalnızca sana görünür.</p>
      {inventory.error && <div role="status" className="mt-4 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-sm leading-relaxed"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" /><span>{inventory.error === 'some_selected_media_unavailable' ? 'Sohbet aktarımı tamamlandı, ancak bazı seçili ekler alınamadı. Eksik dosyalar ilgili mesajlarda belirtilir.' : 'Bazı öğeler aktarılamadı. Durumu yenileyip aynı aktarım üzerinden yeniden deneyebilirsin.'}</span></div>}
      {usernameResult && <div role="status" className="mt-4 rounded-lg border p-4 text-sm leading-relaxed">{usernameResult === 'saving' ? 'Seçtiğin kullanıcı adı uygulanıyor…' : usernameResult === 'updated' ? 'Seçtiğin Discord kullanıcı adı Riparlare’de de uygulandı.' : usernameResult === 'taken' ? 'Bu kullanıcı adı Riparlare’de başka biri tarafından kullanılıyor. Mevcut kullanıcı adın korundu; sohbet aktarımın bundan etkilenmedi.' : usernameResult === 'invalid' ? 'Discord kullanıcı adın Riparlare’nin ad kurallarına uymuyor. Mevcut kullanıcı adın korundu; bu durum sohbet aktarımını engellemez.' : 'Kullanıcı adı değiştirilemedi. Mevcut adın korundu; sohbet aktarımın bundan etkilenmedi.'}</div>}
      {(inventory.destinations?.length ?? 0) > 0 && <div className="mt-6 divide-y rounded-lg border">{inventory.destinations?.map(destination => { const path = destinationPath(destination); return path && <Link key={`${destination.source_id}-${destination.channel_id ?? destination.guild_id}`} to={path} className="flex items-center gap-3 px-4 py-3 text-sm hover:bg-accent"><CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" /><span className="min-w-0 flex-1 truncate">{destination.name}</span><ArrowRight className="h-4 w-4 text-muted-foreground" /></Link> })}</div>}
      {!activeStatus(inventory.status) && !doneStatus(inventory.status) && <button type="button" onClick={() => { setStep(1); setPreview(null); setConfirmed(false) }} className="mt-6 inline-flex items-center gap-2 rounded-md border px-4 py-2 text-sm hover:bg-accent"><RefreshCw className="h-4 w-4" />Seçimleri incele ve yeniden dene</button>}
      <button type="button" disabled={!!busy} onClick={() => void resume(inventory.id)} className="mt-5 block text-sm text-muted-foreground underline underline-offset-4">Durumu yenile</button>
    </div></main>}

    {busy && busy !== 'commit' && <div role="status" aria-live="polite" className="flex shrink-0 items-center gap-3 border-t bg-popover px-5 py-3 text-sm sm:px-8"><Loader2 className="h-4 w-4 shrink-0 animate-spin" /><span className="flex-1">{busy === 'inspect' || busy === 'connect' ? discoveryProgress : (busy === 'collect' || busy === 'scan') && collectorProgress ? `${phaseLabels[collectorProgress.phase]} · ${collectorProgress.messages} mesaj · ${collectorProgress.media} ek${waitingText}` : busy === 'scan' ? 'Geçmiş yalnızca cihazında inceleniyor…' : busy === 'upload' ? (uploadProgress >= 100 ? 'Arşiv sunucuda doğrulanıyor…' : `Arşiv gönderiliyor · %${uploadProgress}`) : busy === 'preview' ? 'Seçimlerin hesaplanıyor…' : 'Aktarım açılıyor…'}</span>{(busy === 'collect' || busy === 'scan' || busy === 'upload' || busy === 'connect' || busy === 'inspect') && <button type="button" onClick={() => void cancelSource()} className="underline underline-offset-4">Durdur</button>}</div>}
    {step > 0 && step < 3 && <footer className="flex shrink-0 items-center justify-between gap-3 border-t bg-sidebar px-5 py-4 sm:px-8"><button type="button" disabled={working} onClick={() => step === 1 ? void resetSource() : setStep(1)} className="inline-flex items-center gap-2 rounded-md px-2 py-2 text-sm text-muted-foreground hover:text-foreground disabled:opacity-40"><ArrowLeft className="h-4 w-4" />{step === 1 ? 'Kaynak değiştir' : 'Seçime dön'}</button><div className="flex min-w-0 flex-col items-end gap-1">{dateError || limitError ? <span className="max-w-sm text-right text-xs text-destructive">{dateError || limitError}</span> : unloadedSelectedGuild && <span className="text-xs text-muted-foreground">Seçili sunucunun kanalları yüklenmeli.</span>}<button type="button" disabled={working || unloadedSelectedGuild || !!limitError || (step === 1 && (!canonical || (!selectedCount && !canonical.guild_ids.length) || !!dateError)) || (step === 2 && (!validPreview || !confirmed))} onClick={() => void (step === 1 ? desktopSource ? desktopScanned ? collect() : scan() : makePreview() : commit())} className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground disabled:opacity-40">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}{step === 1 ? desktopSource && !desktopScanned ? 'Seçili içeriği hazırla' : preparedUpload?.fingerprint === currentFingerprint ? 'Yüklemeyi yeniden dene' : 'Seçimleri incele' : 'Riparlare’ye aktar'}{!busy && <ArrowRight className="h-4 w-4" />}</button></div></footer>}
  </div>
}
