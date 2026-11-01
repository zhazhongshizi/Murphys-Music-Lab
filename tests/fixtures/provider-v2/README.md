# Provider v2 shared fixtures

- `identities.json`: valid/invalid track and container IDs; consumed by Rust, TypeScript and Python schema tests.
- `lifecycle.json`: pure reducer traces, including zero-process startup, cancellation, saved-session restoration, failure, logout and application exit. Effects are specifications; no OS process is started.
- `exchanges.json`: one synthetic request/response per method. Validate response against the pending request's result definition, not just the success envelope.
- `public.json`: renderer-safe examples. Private credentials, CDN URLs and headers are deliberately absent.

All secrets are synthetic; `.invalid` URLs must never be fetched. These fixtures do not establish live API, desktop playback, credential storage, or process-supervision acceptance. See `contracts/provider-v2.md` for stateful and lexical requirements that JSON Schema cannot enforce.
