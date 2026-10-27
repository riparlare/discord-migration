import type { ExternalIdentity } from '@/types'
import { useUiStore } from '@/stores/uiStore'

/** Source attribution is not authentication or a grant of conversation membership. */
export default function ExternalIdentityBadge({ identity }: { identity?: ExternalIdentity }) {
  const openProfile = useUiStore(s => s.openUserProfile)
  if (identity?.provider !== 'discord') return null
  return <div className="text-xs text-muted-foreground">
    <span title={`Discord kimliği: ${identity.subject}`}>{identity.unclaimed ? 'Discord’dan aktarıldı · Hesap sahiplenilmedi' : 'Discord’dan aktarılan profil'}</span>
    {identity.linked_user_id && <button type="button" className="ml-2 text-primary hover:underline" onClick={event => {
      const rect = event.currentTarget.getBoundingClientRect()
      openProfile(identity.linked_user_id!, null, rect.right, rect.top)
    }}>Doğrulanmış Riparlare hesabını gör</button>}
  </div>
}
