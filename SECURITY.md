# Security

Never post account tokens, real archives, SQLite state, signed attachment URLs or other people's private messages in public issues. Reproduce with synthetic data. If a credential is exposed, revoke it through the source service rather than trusting deletion of the public post.

This preview intentionally has no remote telemetry, arbitrary API base URL, client-token extractor, hidden-channel bypass or challenge evasion. Collection sends authorization only to fixed Discord API HTTPS GET endpoints. Media requests use a separate unauthenticated transport and a strict CDN allowlist. Redirects and environment proxy configuration are disabled. Checkpoints and archives contain private content but not credentials; neither format is encrypted.

The Node library's `verifyWith` hook is available only to its trusted host integration. Riparlare's desktop integration offers a separate, default-off consent to send the credential once to its fixed identity-verification endpoint. Ordinary collection does not use that endpoint. The verifier must discard the credential, avoid logging request bodies, and verify the immutable Discord ID independently; an archive or username is never proof of identity. A renderer must never supply an arbitrary verification callback or destination URL.

Please use the repository's private security advisory channel if available. Otherwise contact the maintainers privately before disclosing sensitive reproduction data; a public issue may describe the general problem without secrets. Do not include real token values in any report.

Read access to a source conversation does not imply permission to publish it. Keep private histories private. Imported author attribution, verified account ownership, target membership, and source guild ownership are separate boundaries.
