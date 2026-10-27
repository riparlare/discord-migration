import { describe, expect, it, vi } from 'vitest'
vi.mock('@/lib/connectionConfig', () => ({ getApiBaseUrl: () => 'https://riparlare.test/api/v1' }))
import { nativeImportMediaUrl } from './nativeImportMedia'

describe('native protected import media', () => {
  it('accepts only the configured API origin and fixed numeric channel/attachment route', () => {
    const path = '/api/v1/discord-imports/channels/123/attachments/456'
    expect(nativeImportMediaUrl(path)).toBe(`https://riparlare.test${path}`)
    expect(nativeImportMediaUrl(`https://riparlare.test${path}`)).toBe(`https://riparlare.test${path}`)
    for (const unsafe of [`https://other.test${path}`, `${path}?token=secret`, `${path}#fragment`, '/api/v1/user/me', path.replace('456', 'index-0'), `https://evil@riparlare.test${path}`, path.replace('/123/', '/%31%32%33/')]) {
      expect(nativeImportMediaUrl(unsafe)).toBeNull()
    }
  })
})
