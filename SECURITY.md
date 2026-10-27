# Security

Never post account tokens, real archives, SQLite state, signed attachment URLs or other people's private messages in public issues. Reproduce with synthetic data. If a credential is exposed, revoke it through the source service rather than trusting deletion of the public post.

This preview intentionally has no remote telemetry, credential collector, arbitrary API base URL, client-token extractor, hidden-channel bypass or challenge evasion. Authorization goes only to fixed Discord API HTTPS GET endpoints. Media requests use a separate unauthenticated transport and a strict CDN allowlist. Redirects and environment proxy configuration are disabled. Checkpoints and archives contain private content but not credentials; neither format is encrypted.

Please use the repository's private security advisory channel if available. Otherwise contact the maintainers privately before disclosing sensitive reproduction data; a public issue may describe the general problem without secrets. Do not include real token values in any report.

Read access to a source conversation does not imply permission to publish it. Keep private histories private. Imported author attribution, verified account ownership, target membership, and source guild ownership are separate boundaries.
