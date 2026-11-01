# NetEase Node Provider (`providers/node/netease`)

Host lifecycle, read/write outcomes and validation boundaries: [Protocol v2](../../../contracts/provider-v2.md).
Write endpoints, permission field paths, bounds, outcome mapping and license details: [WRITES.md](WRITES.md).

Stages 3b–3d read/playback and controlled cloud writes for NetEase Cloud Music (`netease`), running as a managed Node subprocess speaking strict Protocol v2 NDJSON over `stdin`/`stdout`. Real account acceptance remains pending.

## 1. Fixed Upstream Baseline & License

- **Upstream Repository**: `NeteaseCloudMusicApiEnhanced/api-enhanced`
- **Version**: `4.41.1`
- **Commit**: `984cc021b8598cf94c22134f32a8426887fb2de7`
- **License**: MIT (`providers/node/netease/upstream/LICENSE`)
- **Integrity Manifest**: `providers/node/netease/upstream-lock.json`

The original 19 files plus four 3d modules (23 files total) are vendored under `upstream/` and locked in `upstream-lock.json`:

- `LICENSE`
- `package.json`
- `module/cloudsearch.js`
- `module/likelist.js`
- `module/login_qr_check.js`
- `module/login_qr_create.js`
- `module/login_qr_key.js`
- `module/login_status.js`
- `module/logout.js`
- `module/lyric_new.js`
- `module/playlist_detail.js`
- `module/playlist_detail_dynamic.js`
- `module/like.js`
- `module/playlist_subscribe.js`
- `module/playlist_tracks.js`
- `module/register_xeapikey.js`
- `module/search.js`
- `module/song_detail.js`
- `module/song_url_v1.js`
- `module/user_playlist.js`
- `util/config.json`
- `util/crypto.js`
- `util/zstd.js`

`module/login_refresh.js` is intentionally omitted in Stages 3b–3d because `auth.credential.refresh` is not declared or invoked; startup credential recovery uses a single `auth.credential.restore` attempt validated via `login_status`. If the saved credential has expired during startup recovery (`login_status` returning `301`/`401`/`20004` or missing `account`/`profile` -> `credential_invalid`) or expires during subsequent `auth.credential.check` / read / playback calls, `Lifecycle::fail(generation, ErrorCode::CredentialInvalid)` (`src-tauri/src/multi_provider/lifecycle.rs:190-202`) stops the subprocess and transitions the snapshot to `PublicStatus::Disabled { error: Some(ErrorCode::CredentialInvalid), retry_after_ms: None }` (`state: "disabled", error: "credential_invalid"`, `src/contracts/providers.ts:51`), mapped to UI copy `"登录已失效，请重新扫码"` (`src/contracts/providerErrors.ts:8`), without silent background refresh loops; the user re-authenticates via QR scan (`auth.qr.start` / `auth.qr.poll`).

## 2. Deterministic Load-Time Patches (`upstream-loader.mjs`)

`upstream-loader.mjs` verifies the SHA-256 of every file in `upstream-lock.json` and rejects any unlisted/extra files under `upstream/` before compiling modules in memory, then applies five targeted patches:

1. **`module/login_qr_check.js`**: Replaces `return {}` in the `catch` block with `throw error` so transport/network failures during QR polling are surfaced as structured `ProviderFault` errors rather than empty objects.
2. **`module/song_url_v1.js`**: Strips the `@unblockneteasemusic/rust-napi` fallback block (`logger.info('开始尝试 unblock') ...`) so unavailable or copyright-restricted tracks are never substituted from third-party or cross-platform sources.
3. **`util/crypto.js`**: Replaces `console.log` with `(()=>{})` so upstream crypto helpers never write non-NDJSON output to `stdout`.
4. **`module/playlist_tracks.js`**: Preserve request construction but replace the whole try/catch with one `return request(...)`. Remove the code-512 duplicate-track resubmission, preserve the actual response body, and propagate rejection. Tests execute the loaded fixed module and real encrypted transport for success/512/disconnect/timeout/5xx, checking one call.
5. **`module/playlist_subscribe.js`**: Explicitly omit the dynamic `query.checkToken='v2'` Watchman SDK instruction. Preserve the fixed module's configured body token. This managed provider does not download/execute the upstream jsdom SDK, collect browser fingerprints, refresh risk tokens or retry writes. Platform verification requirements are reported; acceptance on a real account is pending.

Verify the upstream lock and patches at any time with:

```powershell
& "output/node-24.22.2/bundled/node-v24.22.2-win-x64/node.exe" "providers/node/netease/upstream-loader.mjs" --verify
```

## 3. Runtime & Dependency Rebuild Conventions

- **Fixed Bundled Node Runtime**:
  - Path (Debug / workspace): `output/node-24.22.2/bundled/node-v24.22.2-win-x64/node.exe`
  - Version: `v24.22.2` (`win-x64`)
  - SHA-256: `1c331340fa6cac5e4294725959070a143fa0507195a78ad77eed7943f719aac9`
- **Dependencies**:
  - Locked in `providers/node/netease/package.json` and `providers/node/netease/package-lock.json` (`ajv`, `crypto-js`, `qrcode`).
  - `node_modules/` is gitignored and rebuilt deterministically with:
    ```powershell
    Push-Location "providers/node/netease"
    npm ci --ignore-scripts --no-audit --no-fund
    Pop-Location
    ```
  - Note: `crypto-js@4.2.0` emits an upstream npm deprecation notice during install; it is retained to match the frozen `api-enhanced@4.41.1` crypto baseline without altering cipher behavior.

## 4. Debug vs. Portable / Release Resource Layout

- **Debug (`cargo test` / `cargo run`)**: `src-tauri/src/lib.rs` (`netease_paths`) resolves the workspace root from `CARGO_MANIFEST_DIR/..` and checks `output/node-24.22.2/bundled/node-v24.22.2-win-x64/node.exe` (falling back to `node/node.exe`) plus `providers/node/netease/main.mjs`.
- **Portable / Release (`Stage G` packaging)**: `src-tauri/src/lib.rs` checks the executable directory and Tauri resource directory for `providers/node/netease/main.mjs` (with its production `node_modules`) and `node/node.exe` (verified against the fixed SHA-256 `1c331340fa6cac5e4294725959070a143fa0507195a78ad77eed7943f719aac9`). Portable packaging scripts in Stage G must copy the verified `node.exe` to `node/node.exe` and bundle `providers/node/netease/` with production `node_modules`.
