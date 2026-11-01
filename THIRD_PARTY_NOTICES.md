# Third-Party Notices

本文件记录 Murphy’s Music Lab 的第三方来源与通知。多 Provider 构建的锁定依赖清单及完整许可文本位于 [licenses/provider-g/README.md](licenses/provider-g/README.md) 和 [机器清单](licenses/provider-g/dependencies.json)，portable 保留相同路径；未进入发行物的开发工具不作为运行时依赖列出。

QQ 与 QQ 音乐相关名称、服务和标识归其权利人所有。本项目为非官方社区客户端，不代表腾讯或 QQ 音乐。

## QQMusicApi

- Project: `L-1124/QQMusicApi`
- Source: https://github.com/L-1124/QQMusicApi
- Package: `qqmusic-api-python`
- Locked runtime version: `0.8.2` (`provider/requirements.lock`)
- License: GNU General Public License v3.0 or later
- Use: Python provider 中的 QQ 音乐认证、目录、歌单、歌词和标准 GetVkey 适配。

本项目不复制 `Davied-H/ncm-cli` 源码。该仓库仅作为职责分层和用户流程参考；设计审阅时其根目录未发现许可证文件，因此任何源码复用都不在本项目范围内。

## LBEILC / RhineLabUI

- Source: https://github.com/LBEILC/RhineLabUI
- Vendored code and notice: [vendor/rhine/README.md](vendor/rhine/README.md), [MIT License](vendor/rhine/LICENSE).
- Use: Rhine archive scene, opening sequence and original cassette / assembly models, with local adaptations.
- Copyright (c) 2026 LBEILC. Preserve the upstream MIT license when distributing these portions.
- The upstream's current resource permission covers the author's own original models and screenshots / redistribution. Third-party Arknights names, marks and original-work elements remain excluded; consult the upstream resource-rights statement.

## AMD FidelityFX FSR 1

- Source: https://github.com/GPUOpen-Effects/FidelityFX-FSR/tree/master/ffx-fsr
- License: MIT
- Use: Rhine 3D spatial upscaling trial, adapted from the 32-bit EASU and RCAS algorithms in `ffx_fsr1.h`.
- Adaptations: WebGL2 texelFetch taps instead of texture gathers, floating-point constants, finite reciprocal helpers, and fixed RCAS strength with noise attenuation.

Copyright (c) 2021 Advanced Micro Devices, Inc. All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

## Runtime framework baseline

当前安全本地边界的直接 Rust 依赖包括：

- `rusqlite 0.40.1`（MIT），使用 `bundled` SQLite；
- `zeroize 1.8.2`（Apache-2.0 OR MIT），用于 secret 缓冲区释放清零；
- `uuid 1.23.4`（Apache-2.0 OR MIT），用于关联编号、设备身份和唯一测试目标。

## Multi-provider integration (Stage G)

- API Enhanced `4.41.1`, commit `984cc021b8598cf94c22134f32a8426887fb2de7`: MIT, Copyright (c) 2013-2022 Binaryify. The package contains 22 locked original upstream files plus a local CommonJS `package.json` shim. The dedicated NetEase provider's production dependency closure is locked separately; the upstream application's unused dependencies are not bundled.
- BBPlayer commit `e2e7f52759ad8c79f54ab28021b43df473f849ed`: MIT, Copyright (c) 2025 Roitium. Source: https://github.com/bbplayer-app/BBPlayer . API/response/WBI implementation reference; full original notice is retained in the generated notice directory.
- bili-music commit `94ef03bb97d9ae3117f2f08c3255f17714b61dc3`: MIT, Copyright (c) 2026 Jmiao11. Source: https://github.com/Jmiao11/bili-music . Rust streaming-bridge implementation reference; full original notice is retained. Reference `.txt` files are not runtime providers.
- Node.js `24.22.2` Windows x64: the official archive/executable digests are fixed in `providers/node/runtime.json`. The complete official `LICENSE`, including embedded dependency notices, is preserved.
- All production npm dependency versions, tarball integrity strings, installed metadata/tree hashes and actual license texts for both new providers are recorded in `dependencies.json`. This includes `node-forge`'s alternative BSD-3-Clause/GPL-2.0 terms. Biu and PolyForm Noncommercial code are not dependencies.
- Rust changes since the integration baseline: `futures-util 0.3.32`, `regex 1.13.0`, `reqwest 0.12.28` (`stream`) and `windows 0.61.3` (additional Windows API features). Actual crate licenses and Cargo.lock checksums are recorded. There are no new frontend package dependencies; the existing five-package frontend runtime closure and Rhine MIT text are also retained.
- The QQ Python runtime dependency closure and CPython license are included. `paho-mqtt 2.1.0`'s wheel contains a short `LICENSE.txt` referring to omitted `edl-v10` and `epl-v20` files; the complete texts were recovered from the matching upstream tag, with Git blob checksums retained in `scripts/generate-provider-notices.sources.json`.

Rebuild/check the inventory with the provider virtual environment:

```powershell
& provider/.venv/Scripts/python.exe scripts/generate-provider-notices.py
& provider/.venv/Scripts/python.exe scripts/generate-provider-notices.py --check
```

The inventory's `inputs` hashes prevent independent drift of the lockfiles, runtime metadata and generated notices. It covers the Stage G additions, the frontend runtime closure and the existing QQ Python runtime closure; it is not a complete historical Rust/OS/framework SBOM. Existing Tauri/Rust and Windows system-component terms continue to apply. G is an engineering portable build, not a published release or legal clearance.
