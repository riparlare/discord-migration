import { useEffect, useState } from 'react'
import { axiosInstance } from '@/api/client'
import type { DtoAttachment } from '@/types'
import { nativeImportMediaUrl } from '@/lib/nativeImportMedia'

const EMPTY: DtoAttachment[] = []
type Loaded = { key: string; attachments: Map<string, DtoAttachment>; errors: DtoAttachment[] }
const mediaKey = (attachment: DtoAttachment) => `${attachment.url ?? ''}:${attachment.filename ?? ''}`

export function useNativeImportAttachments(input?: DtoAttachment[] | null) {
  const attachments = input ?? EMPTY
  const key = JSON.stringify(attachments.map(a => [a.filename, a.url, a.preview_url, a.import_status]))
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    const urls: string[] = []
    const pending = attachments.filter(a => a.import_status === 'ready')
    if (!pending.length) return
    void Promise.all(pending.map(async attachment => {
      const url = nativeImportMediaUrl(attachment.url)
      if (!url) return { error: attachment }
      try {
        const response = await axiosInstance.get<Blob>(url, { responseType: 'blob', signal: controller.signal, transformResponse: [data => data] })
        if (controller.signal.aborted) return { error: attachment }
        const blobUrl = URL.createObjectURL(response.data)
        urls.push(blobUrl)
        // The media type is checked by the same normal renderer as native uploads.
        return { sourceKey: mediaKey(attachment), attachment: { ...attachment, url: blobUrl, preview_url: blobUrl } }
      } catch { return { error: attachment } }
    })).then(results => {
      if (!controller.signal.aborted) setLoaded({ key, attachments: new Map(results.flatMap(r => r.attachment && r.sourceKey ? [[r.sourceKey, r.attachment] as const] : [])), errors: results.flatMap(r => r.error ? [r.error] : []) })
    })
    return () => { controller.abort(); urls.forEach(url => URL.revokeObjectURL(url)) }
    // Stable media identity prevents re-fetching after harmless DTO object recreation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  const current = loaded?.key === key ? loaded : null
  return {
    attachments: attachments.flatMap(attachment => {
      if (!attachment.import_status) return [attachment]
      const resolved = current?.attachments.get(mediaKey(attachment))
      return resolved ? [resolved] : []
    }),
    missing: attachments.filter(a => a.import_status === 'source_media_unavailable'),
    errors: current?.errors ?? EMPTY,
    loading: attachments.some(a => a.import_status === 'ready') && !current,
  }
}
