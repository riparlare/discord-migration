import { getApiBaseUrl } from '@/lib/connectionConfig'

/** Only this fixed native-authorized endpoint may receive application credentials. */
export function nativeImportMediaUrl(raw?: string): string | null {
  if (!raw || raw.includes('\\')) return null
  try {
    const base = new URL(getApiBaseUrl())
    const url = new URL(raw, base.origin)
    if (url.origin !== base.origin || url.username || url.password || url.search || url.hash) return null
    const path = `${base.pathname.replace(/\/$/, '')}/discord-imports/channels/`
    if (!url.pathname.startsWith(path) || !/^\d+\/attachments\/\d+$/.test(url.pathname.slice(path.length))) return null
    return url.href
  } catch { return null }
}
