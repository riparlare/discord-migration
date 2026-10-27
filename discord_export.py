"""Read-only device-side exporter. Credentials never belong in archive state."""
import argparse
import getpass
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import warnings
import zipfile

API = "https://discord.com/api/v10"
MAX_RESPONSE = 16 * 1024 * 1024
CDN_HOSTS = frozenset({"cdn.discordapp.com", "media.discordapp.net"})
READ_PATH = re.compile(r"/(?:users/@me(?:/guilds|/channels)?|guilds/[0-9]+(?:/(?:roles|channels|threads/active))?|channels/[0-9]+(?:/messages)?)\Z")


class ExportError(Exception):
    pass


class ApiError(ExportError):
    def __init__(self, status):
        self.status = status
        super().__init__(f"Discord HTTP {status}; permission/authentication may have changed")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Never forward an account credential, or media fetch, to another URL.
        return None


def bounded_json(response):
    raw = response.read(MAX_RESPONSE + 1)
    if len(raw) > MAX_RESPONSE:
        raise ExportError("Response exceeds size limit")
    try:
        return json.loads(raw)
    except (ValueError, UnicodeError):
        raise ExportError("Invalid JSON response") from None


def delay(value):
    try:
        seconds = float(value)
    except (ValueError, TypeError):
        raise ExportError("Invalid rate-limit delay") from None
    if not math.isfinite(seconds) or seconds < 0 or seconds > 3600:
        raise ExportError("Rate-limit delay requires a later manual resume")
    return seconds + 0.1


def snowflake(value):
    if not isinstance(value, str) or not re.fullmatch(r"[1-9][0-9]{0,19}", value) or int(value) >= 2**64:
        raise ExportError("Invalid source identifier")
    return value


class Client:
    def __init__(self, token, opener=None, sleep=time.sleep):
        if not token or any(c.isspace() for c in token):
            raise ExportError("Invalid credential input")
        self._token = token
        # Ignore environment proxy configuration; never allow untrusted redirects.
        self._opener = opener or urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        self._sleep = sleep

    def get(self, path, **params):
        if not READ_PATH.fullmatch(path):
            raise ExportError("Unsupported read endpoint")
        url = API + path + ("?" + urllib.parse.urlencode(params) if params else "")
        for attempt in range(6):
            req = urllib.request.Request(url, headers={"Authorization": self._token,
                "User-Agent": "RiparlareDiscordMigration/0.1 (+https://github.com/riparlare/discord-migration)"}, method="GET")
            try:
                with self._opener.open(req, timeout=30) as response:
                    result = bounded_json(response)
                    if response.headers.get("X-RateLimit-Remaining") == "0":
                        self._sleep(delay(response.headers.get("X-RateLimit-Reset-After", "1")))
                    else:
                        self._sleep(0.35)  # Sequential, conservative; server headers remain authoritative.
                    return result
            except urllib.error.HTTPError as error:
                with error:
                    if error.code == 429:
                        result = bounded_json(error)
                        if not isinstance(result, dict):
                            raise ExportError("Invalid rate-limit response")
                        self._sleep(delay(result.get("retry_after", error.headers.get("Retry-After", "1"))))
                        continue
                    if error.code in (500, 502, 503, 504) and attempt < 5:
                        self._sleep(2**attempt)
                        continue
                    raise ApiError(error.code) from None
            except (urllib.error.URLError, TimeoutError, OSError):
                # Do not include request/headers, remote bodies or raw exceptions.
                raise ExportError("Network request failed; rerun to resume") from None
        raise ExportError("Repeated rate limits; stopped for a later resume")

    def close(self):
        self._token = None  # Python strings cannot guarantee physical memory erasure.


class State:
    def __init__(self, path, owner):
        self.db = sqlite3.connect(path)
        self.db.executescript("""
          CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS channels(id TEXT PRIMARY KEY, payload TEXT NOT NULL,
            cursor TEXT, complete INTEGER NOT NULL DEFAULT 0);
          CREATE TABLE IF NOT EXISTS pages(channel TEXT, cursor TEXT, payload TEXT NOT NULL,
            PRIMARY KEY(channel,cursor));
          CREATE TABLE IF NOT EXISTS guilds(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
        """)
        previous = self.db.execute("SELECT value FROM meta WHERE key='owner'").fetchone()
        if previous and previous[0] != owner:
            self.db.close()
            raise ExportError("Archive belongs to another Discord account; choose another output directory")
        with self.db:
            self.db.execute("INSERT OR IGNORE INTO meta VALUES ('owner',?)", (owner,))

    def capture(self, client, channel_id, max_pages):
        channel_id = snowflake(channel_id)
        channel = client.get(f"/channels/{channel_id}")
        if not isinstance(channel, dict) or channel.get("id") != channel_id:
            raise ExportError("Source channel identity mismatch")
        with self.db:
            self.db.execute("INSERT INTO channels(id,payload) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
                            (channel_id, json.dumps(channel, ensure_ascii=False)))
        cursor, complete = self.db.execute("SELECT cursor,complete FROM channels WHERE id=?", (channel_id,)).fetchone()
        if complete:
            return "already_complete"
        for _ in range(max_pages):
            params = {"limit": 100}
            if cursor:
                params["before"] = cursor
            messages = client.get(f"/channels/{channel_id}/messages", **params)
            if not isinstance(messages, list) or len(messages) > 100:
                raise ExportError("Invalid source message page")
            ids = []
            for message in messages:
                if not isinstance(message, dict) or message.get("channel_id") != channel_id:
                    raise ExportError("Source message channel mismatch")
                ident = snowflake(message.get("id"))
                if cursor and int(ident) >= int(cursor):
                    raise ExportError("Source pagination did not advance")
                ids.append(ident)
            if len(set(ids)) != len(ids):
                raise ExportError("Duplicate IDs in source page")
            next_cursor = min(ids, key=int) if ids else cursor
            # Only an empty response proves pagination end; short pages can still continue.
            complete = not messages
            with self.db:
                self.db.execute("INSERT OR IGNORE INTO pages VALUES (?,?,?)",
                    (channel_id, cursor or "newest", json.dumps(messages, ensure_ascii=False)))
                self.db.execute("UPDATE channels SET cursor=?,complete=? WHERE id=?", (next_cursor, complete, channel_id))
            cursor = next_cursor
            if complete:
                return "complete"
        return "partial_page_limit"

    def guild(self, client, guild_id):
        guild_id = snowflake(guild_id)
        metadata = client.get(f"/guilds/{guild_id}")
        roles = client.get(f"/guilds/{guild_id}/roles")
        channels = client.get(f"/guilds/{guild_id}/channels")
        if not isinstance(metadata, dict) or metadata.get("id") != guild_id or not isinstance(roles, list) or not isinstance(channels, list):
            raise ExportError("Invalid guild structure")
        # Preserve original permission decimal strings and overwrite type/allow/deny.
        # A snapshot never authorizes assigning the same privileges in a target guild.
        with self.db:
            self.db.execute("INSERT OR REPLACE INTO guilds VALUES (?,?)", (guild_id, json.dumps({
                "guild": metadata, "roles": roles, "channels": channels,
                "ownership_verified": False, "permission_mapping_required": True}, ensure_ascii=False)))
        return [snowflake(c.get("id")) for c in channels if c.get("type") in (0, 5)]

    def archive(self, target, media=None, run=None):
        temporary = target.with_suffix(".zip.part")
        statuses = []
        try:
            with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                for ident, payload in self.db.execute("SELECT id,payload FROM guilds ORDER BY length(id),id"):
                    archive.writestr(f"guilds/{ident}.json", payload)
                for ident, payload, complete in self.db.execute("SELECT id,payload,complete FROM channels ORDER BY length(id),id"):
                    statuses.append({"id": ident, "pagination_exhausted": bool(complete),
                        "history_access_verified": False})
                    pages = self.db.execute("SELECT payload FROM pages WHERE channel=? ORDER BY (cursor='newest') DESC,length(cursor) DESC,cursor DESC", (ident,))
                    for index, (rows,) in enumerate(pages):
                        messages = json.loads(rows)
                        if media:
                            for message in messages:
                                for attachment in message.get("attachments", []):
                                    media.copy(archive, ident, message["id"], attachment)
                        archive.writestr(f"channels/{ident}/{index:08}.json", json.dumps({
                            "channel": json.loads(payload), "messages": messages}, ensure_ascii=False))
                archive.writestr("migration-manifest.json", json.dumps({"schema": 1,
                    "tool_version": "0.1.0", "source": "discord-account-read-export",
                    "completeness": "not_proven; empty pages may reflect missing history permissions",
                    "attribution_trusted": False, "channels": statuses,
                    "media": "download_attempted" if media else "references_only",
                    "media_failures": media.failures if media else [],
                    "media_copied": media.copied if media else 0,
                    "claims": "not_identity_proof",
                    "run": run or {"requested_scope": "not_supplied", "coverage": "unknown"},
                    "snapshot": "backwards pagination; edits/deletions/new messages may differ"}))
            os.replace(temporary, target)
        finally:
            if temporary.exists():
                temporary.unlink()


class Media:
    """Separate unauthenticated CDN transport; no account credential is available."""
    def __init__(self, opener=None, max_file=25*1024*1024, max_total=512*1024*1024):
        self.opener = opener or urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        self.max_file, self.max_total = max_file, max_total
        self.total, self.copied, self.failures = 0, 0, []

    def copy(self, archive, channel, message, attachment):
        ident = snowflake(attachment.get("id"))
        url = attachment.get("url", "")
        parsed = urllib.parse.urlsplit(url)
        code = "unavailable"
        try:
            if (parsed.scheme != "https" or parsed.hostname not in CDN_HOSTS or parsed.port not in (None, 443)
                    or parsed.username is not None or parsed.password is not None
                    or not parsed.path.startswith("/attachments/")):
                code = "unsupported_media_origin"
                raise ExportError(code)
            # Spool bounded media privately in memory/disk; publish entry only after success.
            import tempfile
            expected = attachment.get("size")
            if not isinstance(expected, int) or isinstance(expected, bool) or expected < 0 or expected > self.max_file:
                code = "file_size_limit"
                raise ExportError(code)
            if self.total + expected > self.max_total:
                code = "total_size_limit"
                raise ExportError(code)
            req = urllib.request.Request(url, headers={"User-Agent": "RiparlareDiscordMigration/0.1"}, method="GET")
            with self.opener.open(req, timeout=30) as response, tempfile.SpooledTemporaryFile(max_size=1024*1024) as spool:
                digest, size = hashlib.sha256(), 0
                while True:
                    # Count all received bytes, including failed/mismatched downloads.
                    remaining = min(self.max_total - self.total, self.max_file - size + 1)
                    if remaining <= 0:
                        if size == expected:
                            break  # Exact expected completion at the network budget.
                        code = "download_size_limit"
                        raise ExportError(code)
                    # An overlong-file probe is charged to the total network budget.
                    chunk = response.read(min(64*1024, remaining))
                    if not chunk:
                        break
                    size += len(chunk)
                    self.total += len(chunk)
                    if size > self.max_file or self.total > self.max_total:
                        code = "download_size_limit"
                        raise ExportError(code)
                    digest.update(chunk)
                    spool.write(chunk)
                if size != expected:
                    code = "source_size_mismatch"
                    raise ExportError(code)
                name = f"media/{snowflake(channel)}/{snowflake(message)}/{ident}.bin"
                spool.seek(0)
                with archive.open(name, "w") as destination:
                    while chunk := spool.read(64*1024):
                        destination.write(chunk)
                attachment["localpath"] = name
                attachment["sha256"] = digest.hexdigest()
                self.copied += 1
        except (ExportError, urllib.error.URLError, TimeoutError, OSError, ValueError):
            self.failures.append({"channel_id": channel, "message_id": message,
                                  "attachment_id": ident, "code": code})


def discover(client):
    """Best effort metadata inventory, never a completeness or permission claim."""
    channels, failures, guild_ids = {}, [], []
    def add(rows):
        if not isinstance(rows, list):
            raise ExportError("Invalid channel inventory")
        for row in rows:
            if isinstance(row, dict) and row.get("type") in (0, 1, 3, 5, 10, 11, 12):
                channels[snowflake(row.get("id"))] = row
    try:
        add(client.get("/users/@me/channels"))  # User-account endpoint: unsupported/subject to change.
    except ApiError as error:
        if error.status == 401:
            raise
        failures.append({"source": "dm_inventory", "status": error.status})
    after = None
    for _ in range(100):
        params = {"limit": 200}
        if after:
            params["after"] = after
        guilds = client.get("/users/@me/guilds", **params)
        if not isinstance(guilds, list):
            raise ExportError("Invalid guild inventory")
        if not guilds:
            return list(channels.values()), failures, guild_ids
        identifiers = [snowflake(g.get("id")) for g in guilds]
        guild_ids.extend(identifiers)
        if after and any(int(g) <= int(after) for g in identifiers):
            raise ExportError("Guild pagination did not advance")
        for guild_id in identifiers:
            for suffix in ("channels", "threads/active"):
                try:
                    result = client.get(f"/guilds/{guild_id}/{suffix}")
                    add(result.get("threads", []) if suffix != "channels" else result)
                except ApiError as error:
                    if error.status == 401:
                        raise
                    failures.append({"guild_id": guild_id, "source": suffix, "status": error.status})
        after = max(identifiers, key=int)
    raise ExportError("Guild inventory limit reached; use explicit channel IDs")


def private_directory(path):
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink():
        raise ExportError("Output directory cannot be a symlink")
    for name in ("history.zip", "history.zip.part", "resume.sqlite", "resume.sqlite-journal", "resume.sqlite-wal", "resume.sqlite-shm", "channels.json", "failures.json"):
        if (path / name).is_symlink():
            raise ExportError("Output files cannot be symlinks")
        if (path / name).exists() and os.name != "nt":
            (path / name).chmod(0o600)
    if os.name != "nt":
        path.chmod(0o700)


RISK = """Discord user-account automation can lead to account termination. This tool is
not approved by Discord. A user's acceptance does not override Discord's rules.
Only export your own account's permitted histories. Other people's private messages
and media remain private; importing authors does not transfer their account rights.
Your token stays in this process and is sent only to Discord over HTTPS. Archives
and resume state contain private conversations and media URLs: keep them private.
There is no guarantee of complete history, continued access, or account safety.
Policy: https://support.discord.com/hc/en-us/articles/115002192352
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path("exports/discord"))
    parser.add_argument("--channel", action="append", default=[], help="Source channel ID; repeat to select channels")
    parser.add_argument("--guild", action="append", default=[], help="Source guild ID; copy structure/roles/overwrites and readable text histories")
    parser.add_argument("--media", action="store_true", help="Attempt CDN attachment copy (25 MiB/file, 512 MiB/run)")
    parser.add_argument("--all", action="store_true", help="Select discoverable channels and their guild structures; incomplete sources are reported")
    parser.add_argument("--discover", action="store_true", help="List available metadata, without fetching histories")
    parser.add_argument("--max-pages", type=int, default=1000, help="100 messages/page, per channel per run")
    args = parser.parse_args()
    if not args.discover and not args.channel and not args.guild and not args.all:
        parser.error("choose --discover, --all, --guild or explicit --channel IDs")
    if not 1 <= args.max_pages <= 10000:
        parser.error("--max-pages must be 1..10000")
    print(RISK)
    if not sys.stdin.isatty():
        raise ExportError("Interactive terminal required; credentials cannot be piped")
    if input("To accept the risk for your own account, type I ACCEPT: ") != "I ACCEPT":
        print("Cancelled before authentication or network access.")
        return 0
    # Refuse getpass's non-TTY echo fallback instead of leaking the credential.
    with warnings.catch_warnings():
        warnings.simplefilter("error", getpass.GetPassWarning)
        token = getpass.getpass("Discord account token (hidden, never saved): ")
    client, state = Client(token), None
    token = None
    failures = []
    try:
        account = client.get("/users/@me")
        owner = snowflake(account.get("id"))
        private_directory(args.output)
        if args.discover or args.all:
            inventory, failures, guild_ids = discover(client)
            path = args.output / "channels.json"
            path.write_text(json.dumps({"channels": inventory, "failures": failures,
                "warning": "Best effort; closed DMs and archived threads may be missing. Visibility does not prove history permission."}, ensure_ascii=False, indent=2), encoding="utf-8")
            print(f"Inventory saved: {len(inventory)} channels, {len(failures)} unavailable sources.")
            if args.all:
                args.channel.extend(snowflake(c.get("id")) for c in inventory)
                args.guild.extend(guild_ids)
        if args.channel or args.guild:
            state = State(args.output / "resume.sqlite", owner)
            channels = list(args.channel)
            for guild_id in dict.fromkeys(args.guild):
                try:
                    channels.extend(state.guild(client, guild_id))
                    active = client.get(f"/guilds/{snowflake(guild_id)}/threads/active")
                    channels.extend(snowflake(c.get("id")) for c in active.get("threads", []))
                except ApiError as error:
                    if error.status == 401:
                        raise
                    failures.append({"guild_id": guild_id, "http_status": error.status})
            for ident in dict.fromkeys(channels):
                try:
                    status = state.capture(client, ident, args.max_pages)
                    print(f"Channel {snowflake(ident)}: {status}")
                except ApiError as error:
                    if error.status == 401:
                        raise
                    failures.append({"channel_id": ident, "http_status": error.status})
            media = Media() if args.media else None
            state.archive(args.output / "history.zip", media, run={
                "all_discoverable": args.all, "requested_channel_ids": list(dict.fromkeys(args.channel)),
                "requested_guild_ids": list(dict.fromkeys(args.guild)), "failures": list(failures),
                "coverage": "best_effort", "archived_threads_discovered": False,
                "closed_dms_discovered": False})
            if media:
                failures.extend(media.failures)
            print("history.zip saved. Inspect the manifest for incomplete histories and media failures.")
        (args.output / "failures.json").write_text(json.dumps(failures, indent=2), encoding="utf-8")
        return 2 if failures else 0
    finally:
        client.close()
        if state:
            state.db.close()


def cli():
    os.umask(0o077)
    # Never emit a traceback that could include request objects or credentials.
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("Stopped. Rerun with the same output folder to resume.", file=sys.stderr)
        sys.exit(130)
    except (ExportError, getpass.GetPassWarning) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
    except Exception:
        print("Export stopped unexpectedly; private state retained for resume.", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    cli()
