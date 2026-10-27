export interface SourceProgress { phase: 'discovery' | 'messages' | 'media' | 'packing'; channel_id?: string; guild_id?: string; guild_name?: string; guilds_discovered?: number; waiting_ms?: number; messages: number; media: number }
export interface CollectorSelection { channel_ids: string[]; guild_ids: string[]; include_media: boolean; media_types: string[]; include_voice_text: boolean; include_dms: boolean; include_groups: boolean; include_messages?: boolean; excluded_author_ids?: string[]; channel_excluded_author_ids?: Record<string, string[]>; after?: string; before?: string; include_roles?: boolean; include_permissions?: boolean; role_ids?: Record<string, string[]> }
export class DiscordCollector {
  constructor(token: string, options?: {progress?: (event: SourceProgress) => void});
  discover(): Promise<unknown>;
  inspectGuild(guildId: string): Promise<unknown>;
  scan(selection: CollectorSelection): Promise<unknown>;
  collect(selection: CollectorSelection): Promise<Uint8Array>;
  cancel(): void;
  verifyWith(verify: (token: string, accountId: string) => Promise<unknown>): Promise<unknown>;
}

export class SourceError extends Error { status: number; constructor(status: number); }
