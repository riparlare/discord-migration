import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.error
import zipfile

from discord_export import ApiError, Client, ExportError, Media, NoRedirect, State, cli, delay, discover, private_directory, snowflake


class Response(io.BytesIO):
    def __init__(self, data, headers=None):
        super().__init__(data)
        self.headers = headers or {}


class Transport:
    def __init__(self, responses):
        self.responses, self.requests = list(responses), []

    def open(self, request, timeout):
        self.requests.append(request)
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response


def message(ident, channel="22"):
    return {"id": ident, "channel_id": channel, "timestamp": "2026-10-27T00:00:00Z",
            "content": "synthetic", "author": {"id": "33", "username": "fixture"}, "attachments": []}


class Source:
    def __init__(self, pages):
        self.pages, self.params = list(pages), []

    def get(self, path, **params):
        if path == "/channels/22":
            return {"id": "22", "guild_id": "44", "name": "fixture", "type": 0}
        self.params.append(params)
        result = self.pages.pop(0)
        if isinstance(result, Exception):
            raise result
        return result


class ExportTests(unittest.TestCase):
    def test_fixed_origin_get_only_and_no_redirect(self):
        transport = Transport([Response(b'{"id":"11"}')])
        client = Client("synthetic-secret", opener=transport, sleep=lambda _: None)
        self.assertEqual(client.get("/users/@me")["id"], "11")
        request = transport.requests[0]
        self.assertEqual(request.get_method(), "GET")
        self.assertEqual(request.full_url, "https://discord.com/api/v10/users/@me")
        self.assertEqual(request.get_header("Authorization"), "synthetic-secret")
        self.assertIsNone(NoRedirect().redirect_request(request, None, 302, "", {}, "https://other.invalid"))
        for path in ("https://other.invalid", "/users/@me/../../messages", "/channels/22/messages/33", "/webhooks/1/secret"):
            with self.assertRaises(ExportError):
                client.get(path)
        client.close()
        self.assertIsNone(client._token)

    def test_429_delay_and_401_stop_without_body_leak(self):
        limited = urllib.error.HTTPError("url", 429, "limited", {}, io.BytesIO(b'{"retry_after":2}'))
        transport = Transport([limited, Response(b'[]')])
        waits = []
        self.assertEqual(Client("secret", transport, waits.append).get("/channels/22/messages"), [])
        self.assertEqual(waits[0], 2.1)
        denied = urllib.error.HTTPError("url", 401, "secret", {}, io.BytesIO(b'secret'))
        transport = Transport([denied])
        with self.assertRaises(ApiError) as caught:
            Client("secret", transport).get("/users/@me")
        self.assertNotIn("secret", str(caught.exception))
        self.assertEqual(len(transport.requests), 1)

    def test_rate_limit_and_identifiers_are_bounded(self):
        for value in ("NaN", "inf", -1, 5000, None):
            with self.assertRaises(ExportError):
                delay(value)
        for ident in ("01", "-1", "1e10", 123, "18446744073709551616"):
            with self.assertRaises(ExportError):
                snowflake(ident)

    def test_resume_short_pages_duplicate_run_and_account_binding(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)
            state = State(path / "resume.sqlite", "11")
            source = Source([[message("999999999999999999"), message("999999999999999998")], ExportError("network")])
            with self.assertRaises(ExportError):
                state.capture(source, "22", 5)
            state.db.close()
            state = State(path / "resume.sqlite", "11")
            source = Source([[message("999999999999999997")], []])
            self.assertEqual(state.capture(source, "22", 5), "complete")
            self.assertEqual(source.params[0]["before"], "999999999999999998")
            self.assertEqual(source.params[1]["before"], "999999999999999997")
            self.assertEqual(state.capture(Source([]), "22", 5), "already_complete")
            state.archive(path / "history.zip")
            with zipfile.ZipFile(path / "history.zip") as archive:
                rows = [m for name in archive.namelist() if name.startswith("channels/") for m in json.loads(archive.read(name))["messages"]]
                self.assertEqual([m["id"] for m in rows], ["999999999999999999", "999999999999999998", "999999999999999997"])
                self.assertNotIn(b"synthetic-secret", (path / "history.zip").read_bytes())
            state.db.close()
            with self.assertRaises(ExportError):
                State(path / "resume.sqlite", "different-owner")

    def test_cursor_regression_and_wrong_channel_are_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            state = State(Path(folder) / "state.sqlite", "11")
            state.capture(Source([[message("99")]]), "22", 1)
            for rows in ([message("100")], [message("98", "23")], [message("98"), message("98")]):
                with self.assertRaises(ExportError):
                    state.capture(Source([rows]), "22", 1)
            self.assertEqual(state.db.execute("SELECT COUNT(*) FROM pages").fetchone()[0], 1)
            state.db.close()

    def test_guild_permissions_preserve_exact_bits_and_overwrites(self):
        bits = "1152921504606846977"
        class GuildSource:
            def get(self, path):
                if path.endswith("/roles"):
                    return [{"id": "44", "permissions": bits, "position": 0, "managed": False}]
                if path.endswith("/channels"):
                    return [{"id": "22", "type": 0, "parent_id": "55", "position": 1,
                             "permission_overwrites": [{"id": "44", "type": 0, "allow": bits, "deny": "2"}]}]
                return {"id": "44", "owner_id": "66", "name": "fixture"}
        with tempfile.TemporaryDirectory() as folder:
            state = State(Path(folder) / "state.sqlite", "11")
            self.assertEqual(state.guild(GuildSource(), "44"), ["22"])
            state.archive(Path(folder) / "history.zip")
            with zipfile.ZipFile(Path(folder) / "history.zip") as archive:
                structure = json.loads(archive.read("guilds/44.json"))
                self.assertEqual(structure["roles"][0]["permissions"], bits)
                self.assertEqual(structure["channels"][0]["permission_overwrites"][0]["allow"], bits)
                self.assertFalse(structure["ownership_verified"])
            state.db.close()

    def test_media_no_token_size_limits_and_blocked_origin(self):
        transport = Transport([Response(b"GIF89a")])
        media = Media(transport, max_file=20, max_total=20)
        attachment = {"id": "77", "url": "https://cdn.discordapp.com/attachments/22/77/file.gif", "size": 6}
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w") as archive:
            media.copy(archive, "22", "99", attachment)
            blocked = {"id": "78", "url": "https://127.0.0.1/attachments/x", "size": 1}
            media.copy(archive, "22", "99", blocked)
            oversized = {"id": "79", "url": "https://cdn.discordapp.com/attachments/x", "size": 30}
            media.copy(archive, "22", "99", oversized)
        self.assertIsNone(transport.requests[0].get_header("Authorization"))
        self.assertEqual(len(transport.requests), 1)
        self.assertEqual(media.copied, 1)
        self.assertEqual(len(media.failures), 2)
        with zipfile.ZipFile(output) as archive:
            self.assertEqual(archive.read(attachment["localpath"]), b"GIF89a")

    def test_output_symlink_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)
            (path / "history.zip").symlink_to(path / "other")
            with self.assertRaises(ExportError):
                private_directory(path)

    def test_installed_entrypoint_wraps_errors_and_protects_existing_files(self):
        with patch("discord_export.os.umask") as umask, patch("discord_export.main", side_effect=RuntimeError("secret")), patch("sys.stderr", new_callable=io.StringIO) as output:
            with self.assertRaises(SystemExit) as caught:
                cli()
            self.assertEqual(caught.exception.code, 1)
            umask.assert_called_once_with(0o077)
            self.assertNotIn("secret", output.getvalue())
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)
            state_file = path / "resume.sqlite"
            state_file.touch(mode=0o644)
            private_directory(path)
            self.assertEqual(state_file.stat().st_mode & 0o777, 0o600)

    def test_empty_guild_inventory_and_run_failures_survive_archive(self):
        class Inventory:
            calls = 0
            def get(self, path, **params):
                if path == "/users/@me/guilds":
                    self.calls += 1
                    return [{"id": "44"}] if self.calls == 1 else []
                if path == "/users/@me/channels":
                    return []
                if path.endswith("/channels"):
                    raise ApiError(403)
                return {"threads": []}
        channels, failures, guilds = discover(Inventory())
        self.assertEqual(guilds, ["44"])
        self.assertEqual(channels, [])
        self.assertEqual(failures[0]["status"], 403)
        with tempfile.TemporaryDirectory() as folder:
            state = State(Path(folder) / "state.sqlite", "11")
            state.archive(Path(folder) / "history.zip", run={"requested_guild_ids": guilds, "failures": failures})
            with zipfile.ZipFile(Path(folder) / "history.zip") as archive:
                manifest = json.loads(archive.read("migration-manifest.json"))
                self.assertEqual(manifest["run"]["failures"], failures)
            state.db.close()

    def test_failed_media_consumes_network_budget(self):
        transport = Transport([Response(b"123456"), Response(b"123456")])
        media = Media(transport, max_file=20, max_total=10)
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w") as archive:
            for ident in ("77", "78", "79"):
                media.copy(archive, "22", "99", {"id": ident, "url": "https://cdn.discordapp.com/attachments/22/77/file", "size": 1})
        self.assertEqual(media.total, 10)
        self.assertEqual(media.copied, 0)
        self.assertEqual(len(transport.requests), 2)
        self.assertEqual(len(media.failures), 3)

    def test_media_exact_total_budget_is_valid(self):
        media = Media(Transport([Response(b"123456")]), max_file=6, max_total=6)
        with zipfile.ZipFile(io.BytesIO(), "w") as archive:
            media.copy(archive, "22", "99", {"id": "77", "url": "https://cdn.discordapp.com/attachments/22/77/file", "size": 6})
        self.assertEqual(media.copied, 1)
        self.assertEqual(media.total, 6)
        self.assertEqual(media.failures, [])


if __name__ == "__main__":
    unittest.main()
