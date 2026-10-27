# Verification

2026-10-27, Node selective-collector patch:16 synthetic tests passed on the existing Frankfurt Linux QA runner. They include175-guild names-only discovery (4 initial requests), selected-guild caching, optional role403, denied selected-channel metadata and later-page access loss retaining readable history, packing-error retry without rereading, both200/429 rate-wait progress, absolute connection deadline and existing filtering/ZIP/credential isolation. No real account data was used. Native/UI/package release validation is recorded separately by the host application; these tests do not prove full live source coverage.

2026-10-27, preview 0.1.0 source. Application code was not built or tested on a local workstation.

An isolated QA folder on the existing Frankfurt Linux server ran `python3 -m unittest -v` and `python3 -m py_compile discord_export.py`: all 12 tests passed, exit status 0. Inputs were synthetic. HTTP/CDN transports were fake; the test suite made no Discord account requests.

Covered: fixed-origin GET routes, redirect blocking, credential-free CDN requests, bounded rate-limit waits/retries, immediate authentication stop, failure/resume checkpoints, account separation, pagination progress/channel/duplicate validation, exact role permission/overwrite strings, media limits, and output symlink rejection.

The separate backend normalization package passed 13 server-only Go tests and `go vet`, including nested raw Discord channel-page JSON, ignored manifest/media entries, exact source IDs and hostile ZIP inputs. This does not establish live import or ownership linking.

Not verified: real user-token endpoint compatibility, full live account export, all guild/DM discovery, graphical clients, native Riparlare restoration or claims. Public CI checks supported Python runtimes with synthetic data. Account enforcement safety cannot be guaranteed by a test.
