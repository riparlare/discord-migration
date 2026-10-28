import axios from 'axios'
import type { DtoUser } from '@/types'

export function resolveProfileUser(memberUser?: DtoUser, fetchedUser?: DtoUser): DtoUser | undefined {
  return fetchedUser ? { ...memberUser, ...fetchedUser, external_identity: fetchedUser.external_identity } : memberUser
}

export function importedDmUnavailable(error: unknown): boolean {
  if (!axios.isAxiosError(error) || error.response?.status !== 404) return false
  const body = error.response.data
  const code = typeof body === 'string' ? body.trim() : body?.message ?? body?.error
  return code === 'imported_dm_not_available'
}
