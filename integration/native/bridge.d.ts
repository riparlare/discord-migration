import type { ImportInventory, ImportSelection, SourceChannel, SourceGuild, DiscordSourceAccount } from '../ui/lib/discordMigration'

/** Feature-only contract; merge this property into the host's existing Electron API. */
export interface DiscordMigrationBridge {
  connect(input: { token?: string; useSaved?: true; remember?: boolean; riparlare_access_token?: string; riparlare_api_base_url?: string; acceptedRisk: true }): Promise<{
    guilds: SourceGuild[]; channels: SourceChannel[]; warnings: string[]; account?: DiscordSourceAccount
  }>
  savedCredentialStatus?(input: { riparlare_access_token: string; riparlare_api_base_url?: string }): Promise<{ available: boolean; remembered: boolean; account?: DiscordSourceAccount }>
  forgetSavedCredential?(input: { riparlare_access_token: string; riparlare_api_base_url?: string }): Promise<void>
  inspectGuild?(guildId: string): ReturnType<DiscordMigrationBridge['connect']>
  scan(selection: ImportSelection): Promise<ImportInventory>
  collect(selection: ImportSelection): Promise<Uint8Array>
  cancel(): Promise<void>
  disconnect(): Promise<void>
  verifyAccount?(input: {
    riparlare_access_token: string; expected_discord_id: string; accepted_server_verification: true
  }): Promise<{ discord_id: string; username: string; linked: true }>
  onProgress(callback: (event: {
    phase: 'discovery' | 'messages' | 'media' | 'packing'; channel_id?: string; guild_id?: string; guild_name?: string; guilds_discovered?: number; waiting_ms?: number; messages: number; media: number
  }) => void): () => void
}
