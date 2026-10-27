# In-app migration reference modules

This directory publishes migration-specific UI and main-process bridge reference source for the Riparlare1.23 native-history workflow. It is **reference source for a host application, not a standalone application**. The private application/backend, generated clients, existing application source, styles, assets and operational configuration are not included. These modules have host imports by design; copying this directory alone does not produce a buildable app or working server.

## Included files

- `ui/components/migration/`: `DiscordImportWizard`, `SourceTree`, `ImportOptions`, legacy `ImportedHistory`, `NativeHistoryStatus`, `ExternalIdentityBadge` and synthetic UI tests.
- `ui/lib/nativeImportMedia.ts` and `useNativeImportAttachments.ts`: fixed-endpoint validation and authenticated Blob loading; map the hook to the host hooks path if desired.
- `ui/lib/discordMigration.ts`: selection helpers, DTOs, protected-media URL validation and the feature HTTP adapter; adjacent helper tests.
- `native/discord-migration.ts`: Electron main-process IPC registration; imports the public root `../../collector.mjs`.
- `native/bridge.d.ts`: renderer bridge contract to merge into the host API declaration.
- Root `collector.d.mts`: collector type declaration used by the native bridge.

Existing `@/...` imports are **host adapter contracts**, not missing private implementations promised elsewhere in this repository. Map `@` to the host source root and put/map the included helper at `@/lib/discordMigration`. Keep the four components together for their relative imports, or rewrite aliases consistently. Migration reference source is covered by this repository's license.

## Every required host import

| Import | Required host contract |
|---|---|
| `react` | Hooks, JSX runtime and DOM mounting. |
| `react-router-dom` | `Link` and a router provider. Default destination paths are `/app/<guild>/<channel>` and `/app/@me/<channel>`; adapt `destinationPath` for other routes. |
| `react-i18next` | `useTranslation()` returning `t`, used for HTTP error presentation. Most feature labels are Turkish literals; adapt localization rather than assuming a complete locale bundle. |
| `lucide-react` | Icons used by the components. |
| `axios` | Axios error recognition; HTTP requests use the configured instance below. |
| `@/api/client` | Export `axiosInstance` with `get/post/patch`, AbortSignal, FormData/upload progress and Blob response support. Attach the current native bearer token only to trusted API/media origins; retain ID strings and normal session refresh behavior. No credential/request-body logging. |
| `@/lib/connectionConfig` | Export `getApiBaseUrl(): string`, a trusted API v1 base. Media origin/path validation uses this base. |
| `@/lib/apiError` | Export `apiErrorMessage(error, t, fallback): string`, returning sanitized display text without raw credentials/headers/request bodies. |
| `@/lib/queryClient` | Export the TanStack Query `QueryClient` instance used by the host provider, supporting `setQueryData` for the `['settings-user-me']` native profile cache. The host owns refreshing existing guild/DM lists when imported destinations become available. |
| `@/stores/authStore` | Selector hook `useAuthStore(selector)` and `useAuthStore.getState()`, exposing native `token`, `user`, `setUser(user)`. The feature reads `user.id` and `user.discriminator`. Never persist the Discord source credential in this store. |
| `@/stores/messageStore` | `useMessageStore.getState().removeChannelMessages(channelId)`, clearing a projected channel's cached timeline. |
| `@/stores/uiStore` | Selector hook exposing `openUserProfile(userId,guildId,x,y)` for a separate verified-account link. |
| `@/types` | Type-only `DtoUser`, including native `id`, optional `discriminator` and profile fields preserved by the host store. No generated client needs copying here. |
| `@/lib/utils` | Export `cn(...classes): string` for conditional class joining. |
| `@/lib/discordMigration` | Map to the included feature helper, exporting its API/selection functions and DTOs. |

Provide Tailwind utility processing, arbitrary-value classes and semantic theme tokens such as background/foreground, muted, card, sidebar, border, primary and destructive. No stylesheet, branding or assets are bundled. Browser globals include `window`, File/FormData, AbortController, Blob URLs and `document`; these are client components.

Mount `<DiscordImportWizard onClose={...} />` in an authenticated host route/settings panel under router/query providers. Mount `<NativeHistoryStatus channelId={nativeChannelId} channel={nativeChannel} />` beside the normal timeline. Completed projection has no separate archive panel. The host must read imported history through ordinary authorized message APIs, preserve zero/negative `history_start_position`, and refetch on `native-history-projected`. The server creates stable source-time native IDs and no-login profiles; editable archive labels never authenticate authors. Source/native IDs remain distinct strings. The host owns ordinary group membership and message editing authorization.

## Backend contract

The HTTP adapter requires authenticated native-human APIs relative to the configured API v1 base:

| Method/path | Required behavior |
|---|---|
| `POST /discord-imports/archive` | Bounded multipart `file`, untrusted normalization and own-job inventory. |
| `GET /discord-imports` / `GET /discord-imports/:id` | Own jobs/status/destination/progress only. |
| `POST /discord-imports/:id/preview` | Server-validated full selection, exact counts/warnings and source-bound hash. |
| `POST /discord-imports/:id/commit` | `{selection,selection_hash}`, idempotent queue/destination creation and bounded progress. |
| `POST /discord-imports/:id/project-native` | Own committed job, durable idempotent projection/retry, returning full inventory with native_projection status. |
| `GET /discord-imports/channels/:channel_id/attachments/:attachment_id` | Ordinary current channel/participant authorization; no token URL or uploader-only check. |
| `GET /discord-imports/channels/:channel_id/messages` | `before`/`limit` source history page; original uploader plus current destination access. |
| `GET /discord-imports/:id/media/:channel/:message/:attachment` | Exact selected-media authorization/private bytes; no arbitrary URL fetch. |
| `PATCH /user/me/discriminator` | Optional native handle change; 409 taken/400 invalid are nonfatal to importing. |
| `POST /discord-identity/verify` | Separate explicit consent, native session, fresh fixed Discord ID proof, expected-ID check, unique source-ID ownership, safe metadata and no stored token. |

DTOs live in `ui/lib/discordMigration.ts`. This pack does not ship the server. A compatible host must enforce these boundaries itself; client filtering is not authorization. Roles need semantic mapping, private staging and explicit admission. Unknown source-member overrides must not map by username; linking must not grant another person's retained private history.

## Native registration and preload

In the Electron main entry, register `registerDiscordMigration(() => currentMainWindow)` once and retain its returned disconnect function for window teardown. The module also disconnects before quit. `electron` and `node:https` are main-process dependencies, not renderer polyfills. The reference uses a **fixed Riparlare HTTPS identity-verification endpoint**. A fork must deliberately choose a trusted service and matching consent text; do not introduce a renderer-controlled destination.

Expose only `window.electronAPI.discordMigration`, shaped by `native/bridge.d.ts`, through the host's contextBridge preload. Add this property to the host's existing Window declaration; this pack intentionally does not replace the entire existing Electron API.

| Method | IPC channel |
|---|---|
| `connect(input)` | `discord-migration:connect` |
| `inspectGuild(guildId)` | `discord-migration:inspect-guild` |
| `scan(selection)` | `discord-migration:scan` |
| `collect(selection)` | `discord-migration:collect` |
| `cancel()` / `disconnect()` | `discord-migration:cancel` / `discord-migration:disconnect` |
| Optional `verifyAccount(input)` | `discord-migration:verify-account` |
| `onProgress(callback)` | Listen to `discord-migration:progress`; return a function removing that exact listener. |

Send progress data to callbacks, not Electron event objects. Never expose ipcRenderer, generic URL requests, arbitrary filesystem methods, the collector instance or its `verifyWith` callback directly to renderer code. Keep context isolation, a sandboxed renderer and host navigation/origin guards. Main handlers additionally require the current app window's webContents and top-level mainFrame; iframe/other-window calls are denied. A browser host omits this optional capability and still supports archive upload.

## Consent and privacy

Normal flow: own-credential input → names-only source list → selected-guild structure → device-only selected-history scan → local author/content choices → filtered media/ZIP → upload → preview → explicit commit. Scan neither downloads attachments nor uploads messages. Collection filters before retained-media requests/serialization. The native reference opts into `retainAfterCollect:true` and releases transient credentials/cache after successful upload acknowledgement, cancellation, window closure or ten-minute idle expiry. The renderer keeps prepared ZIP bytes only while its import component stays open; a failed upload can retry the same bytes, while changed filters invalidate them and re-pack inspected rows. Failed bounded packing retains inspected rows for a smaller retry. No disk persistence or physical secure-erasure guarantee is added. Hosts using the collector default still release on successful packing.

Automation-risk acceptance is **not** server credential-transfer consent. The independent default-off linking choice expressly authorizes one-time verification, enforced by the bridge's `accepted_server_verification:true`, native JWT and expected discovered Discord ID. Only safe link metadata returns to the renderer. The default collection path never sends its source credential to Riparlare.

Username adoption is another independent default-off choice. Names may differ, identity binds only an actual verified Discord ID, and a taken/invalid native name preserves the existing name while importing continues. Uploaded labels are untrusted, so adoption does not prove identity. After projection, guild history/media follows ordinary destination permissions; DM/group/private-thread history remains participant scoped. A verified claim links a native account to an unclaimed profile without granting another person's private conversation or source-server roles.

Additional host types: `DtoChannel.history_start_position?:number`, `history_import?:{state:'projecting'|'complete'|'failed',legacy_archive_visible:boolean}`; `DtoUser.external_identity?:ExternalIdentity`, where `ExternalIdentity={provider:'discord',subject:string,unclaimed:boolean,linked_user_id?:string}`; `DtoAttachment.import_status?:'ready'|'source_media_unavailable'`. Normal message DTOs expose `imported_from` with provider, original channel/message IDs, source timestamp and `attribution_verified:false`. Protected media must use authenticated Blob loading and revoke object URLs; missing source bytes must remain explicit.

## Tests and portability

Included UI/helper tests use synthetic content and mocked feature API calls. A compatible host harness needs Vitest, jsdom, React Testing Library, user-event, jest-dom matchers/setup and the aliases/adapters above. Wizard tests use the host auth/query adapters. No private implementation or standalone UI dependency manifest is included. Public CI runs dependency-free root collector/Python tests; it does not claim these host-dependent reference UI modules build independently.

No local install, test or build was performed while preparing this pack. Source inclusion does not establish a working fork/backend or complete Discord source coverage. Keep credentials, archives, real conversations and operational configuration out of fixtures/issues.
