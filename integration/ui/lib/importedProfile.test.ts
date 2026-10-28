import { describe, expect, it } from 'vitest'
import { importedDmUnavailable, resolveProfileUser } from './importedProfile'

describe('imported native profiles', () => {
  it('uses refreshed source identity while retaining unrelated member hints', () => {
    const identity = { provider: 'discord' as const, subject: '123', unclaimed: true }
    expect(resolveProfileUser({ name: 'Stale' }, { name: 'Ada', external_identity: identity })).toMatchObject({ name: 'Ada', external_identity: identity })
  })
  it('distinguishes missing caller-owned DM from general errors and private access denial', () => {
    expect(importedDmUnavailable({ isAxiosError: true, response: { status: 404, data: 'imported_dm_not_available' } })).toBe(true)
    expect(importedDmUnavailable({ isAxiosError: true, response: { status: 404, data: { message: 'imported_dm_not_available' } } })).toBe(true)
    for (const error of [new Error('imported_dm_not_available'), { isAxiosError: true, response: { status: 403, data: { message: 'imported_dm_not_available' } } }, { isAxiosError: true, response: { status: 404, data: { message: 'not_found' } } }]) expect(importedDmUnavailable(error)).toBe(false)
  })
})
