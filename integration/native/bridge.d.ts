import type { ImportInventory, ImportSelection, SourceChannel, SourceGuild, DiscordSourceAccount } from '../ui/lib/discordMigration'

/** Feature-only contract; merge this property into the host's existing Electron API. */
export interface DiscordMigrationBridge {
  connect(input: { token: string; acceptedRisk: true }): Promise<{
    guilds: SourceGuild[]; channels: SourceChannel[]; warnings: string[]; account?: DiscordSourceAccount
  }>
  scan(selection: ImportSelection): Promise<ImportInventory>
  collect(selection: ImportSelection): Promise<Uint8Array>
  cancel(): Promise<void>
  disconnect(): Promise<void>
  verifyAccount?(input: {
    riparlare_access_token: string; expected_discord_id: string; accepted_server_verification: true
  }): Promise<{ discord_id: string; username: string; linked: true }>
  onProgress(callback: (event: {
    phase: 'discovery' | 'messages' | 'media' | 'packing'; channel_id?: string; messages: number; media: number
  }) => void): () => void
}
