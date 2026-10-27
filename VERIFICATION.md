# Verification

2026-10-28,1.23 host reference: the shared UI passed44 focused synthetic tests on the existing Frankfurt runner. The desktop host passed32 wizard/helper and12 additional native-history tests, plus its existing desktop/sync/release suites, without adding to its237 inherited type diagnostics. An isolated real SQL/CQL API and two synthetic actors verified native message/media persistence, ordinary authorized second-member reads, revoked access, no-login profiles, private DM/thread isolation and idempotent requeue. The built Electron1.23.0 file-origin candidate rendered ordinary history, protected media, profile cards and retained DMs;1.22.2 could still read ordinary messages through the new API. Old versions lack full protected-media/deep-prepend UX. These are host application checks, not a claim that the public reference directory builds standalone or that every Discord source is discoverable.

2026-10-27, upload-retry patch:18 synthetic Node collector tests passed on the Frankfurt QA server. New cases cover metadata/permission changes between guild discovery and channel inspection, and opt-in repacking without rereading inspected messages. The previous collector produced an archive rejected by the actual isolated Riparlare API with409 `archive_source_conflict`; the same synthetic fixture with this patch received201. Strict conflict rejection remains enabled. These tests use synthetic source responses and do not prove any particular live account's complete history.

2026-10-27, Node selective-collector patch:16 synthetic tests passed on the existing Frankfurt Linux QA runner. They include175-guild names-only discovery (4 initial requests), selected-guild caching, optional role403, denied selected-channel metadata and later-page access loss retaining readable history, packing-error retry without rereading, both200/429 rate-wait progress, absolute connection deadline and existing filtering/ZIP/credential isolation. No real account data was used. Native/UI/package release validation is recorded separately by the host application; these tests do not prove full live source coverage.

2026-10-27, preview 0.1.0 source. Application code was not built or tested on a local workstation.

An isolated QA folder on the existing Frankfurt Linux server ran `python3 -m unittest -v` and `python3 -m py_compile discord_export.py`: all 12 tests passed, exit status 0. Inputs were synthetic. HTTP/CDN transports were fake; the test suite made no Discord account requests.

Covered: fixed-origin GET routes, redirect blocking, credential-free CDN requests, bounded rate-limit waits/retries, immediate authentication stop, failure/resume checkpoints, account separation, pagination progress/channel/duplicate validation, exact role permission/overwrite strings, media limits, and output symlink rejection.

The separate backend normalization package passed 13 server-only Go tests and `go vet`, including nested raw Discord channel-page JSON, ignored manifest/media entries, exact source IDs and hostile ZIP inputs. This does not establish live import or ownership linking.

Not verified: real user-token endpoint compatibility, full live account export, all guild/DM discovery, graphical clients, native Riparlare restoration or claims. Public CI checks supported Python runtimes with synthetic data. Account enforcement safety cannot be guaranteed by a test.
