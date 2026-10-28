# Riparlare Discord migration

Independent, open-source **preview** collection tools for moving your own accessible Discord histories toward Riparlare:

- `discord_export.py`: Python 3.11+ standalone exporter, standard library only.
- `collector.mjs`: Node.js 22+ collection library, built-in modules only, for a host application's selective import flow. It is not a command-line login program or the Riparlare application/backend.
- [`integration/`](integration/README.md): migration-specific React UI, HTTP/selection helpers, synthetic UI tests and Electron main bridge reference source. These are **host integration modules, not a standalone application**; required adapters/providers are documented explicitly.

Neither tool modifies the Discord client, extracts installed-client credentials, opens a gateway connection, bypasses permissions or sends analytics. History collection keeps your Discord credential on your device. A host may offer a **separate, default-off identity verification choice** that sends it once to Riparlare; that exception requires its own explicit consent, described below.

**User-account automation violates Discord's published policy and can lead to account termination.** The Python CLI requires interactive risk acceptance before prompting for a credential or making requests. A Node host must provide equivalent disclosure and consent before constructing the collector; the library does not display its own prompt. Acceptance does not change Discord's rules, guarantee safety, or grant permission to publish other people's content. [Discord policy](https://support.discord.com/hc/en-us/articles/115002192352-Automated-User-Accounts-Self-Bots).

## Python CLI capabilities

- Select channels, a guild, or best-effort discoverable histories including available DMs/group DMs.
- Export all authors returned by the source, original message IDs/timestamps/content/replies and attachment metadata.
- Save guild structure: categories, channel order/parents, roles, exact decimal permission bitfields, channel role/member overwrite entries, and other returned metadata. No JavaScript client injection is needed to read these API responses.
- Copy image/video/file attachments with `--media`, recording failed downloads. Only fixed Discord CDN HTTPS attachment URLs are fetched, without the account token. Limits: 25 MiB/file, 512 MiB/run.
- Resume backwards pagination using transactional local SQLite checkpoints, with account binding and idempotent pages. Short responses are followed until an empty page; authentication failures stop. Permission failures are reported, not bypassed.
- Export channel-page JSON envelopes in a ZIP, keeping IDs as strings, and a completeness/failure manifest.

The CLI exports ZIP files; it does not import them into Riparlare, create destination guilds/roles/channels, link accounts or supply a graphical interface. Public [`integration/`](integration/README.md) supplies feature-only reference UI/native bridge modules for the in-app migration flow. The full private application/backend, generated clients, styles/assets and operational configuration are not included. Neither collector guarantees archived-thread or closed-DM discovery, membership/role restoration, complete reaction/voter histories, deleted messages, expired attachments or inaccessible content. The CLI preserves raw message fields returned by Discord; downstream normalization may support fewer fields.

Guild snapshots are data, not ownership proofs. Original role/channel/user IDs require mapping to new target IDs before restoration. Source bot-managed roles cannot simply become managed target roles. Source ownership, target authorization and member-specific overwrites need independent verification; never assign an imported author's privileges to an unrelated target account. Permissions may change during capture. Messages edited/deleted during backwards pagination and newer messages after the first page are not an atomic snapshot. Completed histories are not automatically refreshed; use a new output directory for a fresh snapshot.

An empty history response proves only pagination exhaustion: Discord may also return no messages when history permission is missing. The manifest explicitly marks history access as unverified. A zero-error run is not proof that every source message was copied. [Get Channel Messages](https://docs.discord.com/developers/resources/message#get-channel-messages).

## Run the Python CLI

Download the source from this repository. From its folder:

```console
python discord_export.py --discover
python discord_export.py --channel 123456789012345678 --media
python discord_export.py --guild 123456789012345678 --media
python discord_export.py --all --media
```

Use your own IDs. `--channel` and `--guild` can be repeated. Discovery reads metadata only; it is not a guarantee of message-history permission. Guild export attempts text/announcement channels plus currently listed active threads; supply other known accessible thread/channel IDs explicitly. `--all` selects the best-effort inventory, not invisible or undiscoverable history. The account-only DM inventory endpoint is undocumented for general application use and can fail or change.

The terminal asks you to type `I ACCEPT`, then enter your own token without echo. **Do not put a token in a command, issue, screenshot, environment variable, archive or chat.** This program deliberately has no token command-line argument, credential file reader or installed-client token extractor. It sends the token only to `https://discord.com/api/v10` through fixed GET routes, with redirects and environment proxies disabled. Stop and investigate any unexpected authentication challenge; the tool provides no challenge/anti-bot evasion.

Use `python3` if your system uses that name. Optionally install with `pip install .` for the `riparlare-discord-export` command. No third-party runtime package is required. Test and build automation runs on server runners.

`--output PATH` changes the output folder (default `exports/discord`). `--max-pages N` bounds each selected channel per run (default 1000 pages, at most 100 messages/page). Rerun with the same account, output and channels to continue. Exit 0 means the selected run completed without recorded HTTP/media failures; consult manifest channel completeness because a page limit can still leave partial histories. Exit 2 means recorded partial failures; 1 means fatal failure; 130 means cancelled. On a fatal error, SQLite retains committed pages; an existing ZIP may still be the previous snapshot. Re-run to regenerate it.

Output:

```text
exports/discord/
  channels.json       # when discovery is requested
  resume.sqlite       # private raw history/checkpoints; no token
  failures.json       # source identifiers and bounded error codes
  history.zip
    migration-manifest.json
    guilds/<guild-id>.json
    channels/<channel-id>/<page>.json
    media/<channel-id>/<message-id>/<attachment-id>.bin
```

Treat **all output as private**, including signed media URLs. ZIP/SQLite are not encrypted. Unix output directory mode is 0700 and CLI-created files use a 077 umask; Windows relies on your existing user-directory ACLs. Choose a private user directory. Python cannot guarantee secure erasure of immutable credential strings from process memory; the credential reference is dropped on close. Media files are freshly attempted when generating each ZIP; message checkpoints resume independently. Original filenames and content-type metadata remain in message records; stored file paths use source IDs instead of unsafe filenames.

Backend archive readers may impose smaller ZIP/file/message limits than this exporter. Split large source selections into separate output directories or explicitly configure appropriate bounded import limits. A ZIP can contain many pages/media and is not guaranteed to fit the default backend preview limits.

## Node collector and intended integrated flow

`collector.mjs` exports `DiscordCollector`, with `discover()`, `inspectGuild(guildId)`, `scan(selection)`, `collect(selection)` and `cancel()`. No npm install, application secrets or Discord OAuth application registration is required to use the collection library. Running `node collector.mjs` alone does not open a UI or collect data. The host is responsible for private credential input, risk disclosure, cancellation, progress display and any later upload/import action. Do not supply credentials through command arguments, environment variables, files or public examples.

The intended Riparlare desktop flow uses a narrow main-process bridge:

1. The user enters their own credential and accepts the account risk. The renderer clears its input; the main process holds the credential transiently and discovers the account, discoverable DMs and guild names through fixed Discord HTTPS GET endpoints. Guilds start with `channels_loaded:false`; `inspectGuild(guildId)` loads only a known selected guild's roles/channels/active threads and caches the result.
2. The user selects guilds, categories/channels, voice/stage text, DMs/groups and content choices. `scan(selection)` reads selected histories into bounded device memory and returns author/count inventory. It does **not** upload content or download attachments. With `include_messages:false`, it requests no message histories.
3. The user inspects the local inventory and adjusts global/per-channel author exclusions, dates, message/media types and role choices. `collect(selection)` reuses the scanned rows and filters messages **before** downloading retained attachments or writing ZIP entries. It omits nested quoted-message payloads that could otherwise carry excluded content. Empty selected conversations retain metadata envelopes. Expanding to histories that were not scanned requires another source inspection.
4. Only the filtered ZIP is handed back to the host for upload. The server independently validates and previews the selection before an explicit commit creates destinations. No native destination or account membership is created by this library itself.

Node collection limits are **64 MiB per ZIP**, **100,000 scanned messages**, 32 MiB of cached message JSON, 8 MiB per API response and at most 4095 ZIP entries. Attachment attempts allow 16 MiB per file and a 32 MiB download budget per collection; failed attempts consume the budget too. Histories are capped at 1000 pages of at most 100 messages per channel. These differ from the Python CLI's file/download limits. A smaller limit may be reached before the message cap, and backend acceptance is separately bounded. Divide large selections into smaller imports.

Node scan state is memory-only, without the Python CLI's persistent SQLite resume. The1.23.1 reference desktop host can separately remember an explicitly opted-in source credential in a dedicated OS-encrypted device vault; this does not persist scanned histories or add restart recovery for an unfinished import. By default, cancellation or successful final collection drops the collector's credential/cache references. A host can explicitly set `retainAfterCollect:true` to retry uploading or re-filtering without rereading the source; it must call `cancel()` after upload acknowledgement, cancellation, window closure or a bounded idle timeout. The reference Electron bridge uses ten minutes. A failed packing attempt also retains the inspected state for a smaller retry. Prepared ZIP bytes remain only in the open import UI and are invalidated when filters change. Guild and message envelopes use the same inspected channel snapshot, including permission overwrites.403/404 channel failures retain listed structure and already-read pages with explicit failure records; unavailable history is never bypassed. Language/runtime buffers do not guarantee physical secure erasure. The Node library makes fixed-origin read requests, follows no redirects and fetches approved Discord CDN attachment URLs without Authorization. Permissions and 429 delays are respected; account challenges are not bypassed.

## Optional identity linking and native username

History collection and identity verification are distinct permissions. Collection does not send the Discord token to Riparlare. In the intended integrated UI, the separately unchecked **“Link my Discord account”** choice explicitly authorizes a one-time transfer to Riparlare's fixed HTTPS verification endpoint. The main bridge then uses a current Riparlare session and the expected discovered Discord ID; it returns safe link metadata, never the Discord credential, to the renderer. The server verifies the actual immutable ID against Discord and does not save the token. The collection library's `verifyWith(callback)` is only a hook for a trusted host implementing that separate flow; it does not enforce a host's consent UI or choose a verification destination itself.

Discord and Riparlare usernames **do not need to match**. Identity linking uses the verified Discord ID, not names. A separate optional native username change may be offered; a taken or invalid name keeps the existing name and must not prevent the import. An uploaded archive, account label or username change never proves identity or source guild ownership.

The1.23 host integration projects selected history into ordinary native messages, attachments and no-login unclaimed profiles. Guild history follows current destination channel permissions; private conversations remain participant scoped. Source private threads require an actual private native conversation rather than inherited parent access. Verified identity linking supplies a profile link, without transferring another person's DM access, source-server ownership or roles. The retained source archive remains uploader only as a recovery source. The public repository supplies reference modules, not the private native persistence implementation; see the required host contract in integration/README.md.

## Trust and verification

An exported source author is unclaimed metadata. Uploading a JSON archive, controlling this tool, or supplying a source ID does not prove that author wrote the submitted text or owns a Riparlare account. Account linking must verify the immutable Discord ID independently. Even verified ID control does not authenticate text inside an editable archive. Linking must not grant access to another person's private archives or transfer a source guild's ownership.

Tests use synthetic accounts, fake transports, temporary databases and tiny media fixtures. Python tests cover token routing, rate limits, checkpoints, source account binding, permission precision, CDN restrictions and file bounds. Node tests cover the collection/ZIP contract, local inspection, content exclusions before media fetch/upload, structure-only choices, limits and cancellation. Run them on an authorized test runner:

```console
python -m unittest -v
python -m py_compile discord_export.py
node --test collector.test.mjs
node --check collector.mjs
```

CI is configured to run the dependency-free suites on Python 3.11/3.13 and Node 22/24. Fake-transport results do not prove live endpoint compatibility, full source coverage or account safety. See [verification](VERIFICATION.md) for the scope/date of recorded results; it is not a live deployment certificate.

Report software problems without credentials, database files, real archives, signed URLs or private messages. See [SECURITY.md](SECURITY.md).

MIT licensed. Not affiliated with or endorsed by Discord.
