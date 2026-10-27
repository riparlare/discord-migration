# Riparlare Discord migration

An independent, open-source **preview** exporter for moving your own accessible Discord histories toward Riparlare. Python 3.11+, standard library only. No Discord client modification, token extraction, gateway connection, analytics, or Riparlare credential endpoint.

**User-account automation violates Discord's published policy and can lead to account termination.** Each run requires an interactive risk acceptance before prompting for a credential or making requests. Acceptance does not change Discord's rules, guarantee safety, or grant permission over other people's content. [Discord policy](https://support.discord.com/hc/en-us/articles/115002192352-Automated-User-Accounts-Self-Bots).

## Current capabilities

- Select channels, a guild, or best-effort discoverable histories including available DMs/group DMs.
- Export all authors returned by the source, original message IDs/timestamps/content/replies and attachment metadata.
- Save guild structure: categories, channel order/parents, roles, exact decimal permission bitfields, channel role/member overwrite entries, and other returned metadata. No JavaScript client injection is needed to read these API responses.
- Copy image/video/file attachments with `--media`, recording failed downloads. Only fixed Discord CDN HTTPS attachment URLs are fetched, without the account token. Limits: 25 MiB/file, 512 MiB/run.
- Resume backwards pagination using transactional local SQLite checkpoints, with account binding and idempotent pages. Short responses are followed until an empty page; authentication failures stop. Permission failures are reported, not bypassed.
- Export channel-page JSON envelopes in a ZIP, keeping IDs as strings, and a completeness/failure manifest.

**Not implemented yet:** importing this archive into the live Riparlare app, creating target guilds/roles/channels, verified identity claiming, a graphical interface, archived-thread discovery, closed-DM discovery, membership/role restoration, and complete reaction/voter histories. Raw message fields such as embeds and reactions are preserved when returned; normalization may not support all of them. This tool does not claim to copy every channel, deleted message, expired attachment, or inaccessible content.

Guild snapshots are data, not ownership proofs. Original role/channel/user IDs require mapping to new target IDs before restoration. Source bot-managed roles cannot simply become managed target roles. Source ownership, target authorization and member-specific overwrites need independent verification; never assign an imported author's privileges to an unrelated target account. Permissions may change during capture. Messages edited/deleted during backwards pagination and newer messages after the first page are not an atomic snapshot. Completed histories are not automatically refreshed; use a new output directory for a fresh snapshot.

An empty history response proves only pagination exhaustion: Discord may also return no messages when history permission is missing. The manifest explicitly marks history access as unverified. A zero-error run is not proof that every source message was copied. [Get Channel Messages](https://docs.discord.com/developers/resources/message#get-channel-messages).

## Run

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

## Trust and verification

An exported source author is unclaimed metadata. Uploading a JSON archive, controlling this tool, or supplying a source ID does not prove that author wrote the submitted text or owns a Riparlare account. Future account linking must verify the immutable Discord subject independently. Linking must not grant access to another person's private archives or transfer a source guild's ownership.

Tests use synthetic accounts, fake transports, temporary databases and tiny media fixtures. They cover token routing, rate limits, resume after failures, ordering/cursor validation, source account binding, permission precision, CDN restrictions and file bounds. No real account import or live Riparlare integration has been verified. See [verification](VERIFICATION.md).

Report software problems without credentials, database files, real archives, signed URLs or private messages. See [SECURITY.md](SECURITY.md).

MIT licensed. Not affiliated with or endorsed by Discord.
