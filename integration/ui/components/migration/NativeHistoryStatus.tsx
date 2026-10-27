import type { DtoChannel } from '@/types'
import ImportedHistory from './ImportedHistory'

export default function NativeHistoryStatus({ channelId, channel }: { channelId: string; channel?: DtoChannel | null }) {
  const history = channel?.history_import
  if (!history) return null
  return <>
    {history.state === 'projecting' && <p role="status" className="px-4 py-2 text-xs text-muted-foreground">Aktarılan mesajlar sohbete hazırlanıyor. Hazır oldukça bu kanalda görünecek.</p>}
    {history.state === 'failed' && <p role="alert" className="px-4 py-2 text-xs text-destructive">Geçmişin sohbete aktarımı tamamlanamadı. Kaynak arşiv korundu; aktarım ekranından durumu kontrol edebilirsin.</p>}
    {history.legacy_archive_visible && history.state !== 'complete' && <ImportedHistory channelId={channelId} />}
  </>
}
