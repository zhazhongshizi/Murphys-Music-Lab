# 开发与发行

环境为 Windows x64、Node.js 24、pnpm 11、Rust stable 1.88+ MSVC、Visual Studio Build Tools、Windows SDK、WebView2 与 Python 3.13 x64。

```powershell
pnpm install --frozen-lockfile
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/bootstrap-provider.ps1 -PythonExe "C:\Path\To\Python313\python.exe"
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-provider.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/bootstrap-node-runtime.ps1
npm ci --prefix providers/node/netease --ignore-scripts
npm ci --prefix providers/node/bilibili --ignore-scripts
& .\provider\.venv\Scripts\python.exe scripts/generate-provider-notices.py
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/debug-review.ps1 -Action Run
```

Provider `.venv`、`build`、`dist`、staged resources 为本地生成物。Python 修改后要运行冻结桌面版或发行时重新冻结；纯 Python 测试不需冻结。

## QQ 请求身份与错误分类

平台策略入口为 [request_policy.py](../provider/qqmusic_provider/request_policy.py)：默认 Desktop，表中注明应用主动覆盖的平台及原因，也列出 SDK 固定的 Android 分类搜索和 Web 歌曲详情。SDK 自己指定的平台继续由 SDK 执行，不统一改写成客户端默认值。`playback.original` 仅指原曲取流，不包含 MV。

请求描述符经 `apply_request_identity` 应用策略；SDK 协程接口经 `QQMusicSession.executor_for` 绑定本次操作的身份和当前凭据。两种入口共用同一策略表、客户端和请求引擎，不切换共享客户端的 `platform`。SDK 私有引擎访问仍集中在 session 兼容边界，升级时需验证。

[upstream_errors.py](../provider/qqmusic_provider/upstream_errors.py) 统一网络、限流、凭据拒绝、解析和未知错误的分类；各服务保留原有公开错误码。登录专属错误在认证适配器映射。只有本地凭据反序列化可以把类型／格式错误解释为存储凭据损坏；远端检查或刷新响应、Android 设备初始化的解析错误不能证明账号失效。分类中的 `retryable` 不授权自动重放写操作。

[SDK 兼容测试](../provider/tests/test_upstream_compatibility.py) 覆盖目录平台矩阵、歌单写入身份、Windows 刷新后 Android 核验、并发与客户端重建、Android 冷启动及畸形刷新响应；[错误契约测试](../provider/tests/test_upstream_errors.py) 检查各模块的错误码与重试标记。

真实账号验收由账号持有人在新版 Debug 中执行：

1. 完全退出旧实例后打开规范 Debug，确认登录状态、搜索、猜你喜欢和自建歌单读取正常。
2. 选一首测试歌曲，记录原红心及目标自建歌单状态，再测试喜欢／取消喜欢、添加／移出；完成后恢复原状态。已喜欢或已在歌单中的歌曲不要误删。
3. 对比原曲播放与需要 MV 回退的歌曲，并确认其他曲库操作未受影响。
4. 长期刷新验收需等待自然过期或使用现有刷新入口，检查刷新后推荐、播放和写入仍正常；不要修改凭据文件或以重新扫码成功代替刷新验收。暂未触发刷新时记为未验收。

离线测试通过不等于上述真实账号流程已验收。

## 常用验证与构建

| 命令 | 用途 |
| --- | --- |
| `pnpm dev` | 编译 Rhine 并预览前端，真实桌面能力需 Tauri |
| `pnpm typecheck`、`pnpm test:run` | 类型与前端测试 |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib` | Rust 测试 |
| `provider/.venv/Scripts/python.exe -m pytest provider/tests` | Provider 测试 |
| `scripts/build-frontend.ps1` | 主／Remote 生产前端 |
| `scripts/verify-fast.ps1 -Scope Frontend` | 定向验证，可选 Frontend／Rust／Provider／All |
| `scripts/build-portable.ps1` | 默认 Windows x64 portable |

PowerShell 脚本使用 `powershell -NoProfile -ExecutionPolicy Bypass -File ...`。Debug 路径为 `src-tauri/target/debug/qqmusic-gui.exe`，避免覆盖运行或审阅实例。验证按影响选择，编译与浏览器不能替代 WebView2、账号和真实播放验收。

Portable 默认冻结／stage Provider、构建主和 Remote 前端、编译 Release，在 `output/releases/` 创建唯一目录与 ZIP。标准脚本包含 Provider 清单、live 模式和目标检查，不读取个人账号或听歌数据库。NSIS 安装包需显式用 `scripts/build-release.ps1 -Installer`。

版本同步 `package.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock` 应用条目与 `src-tauri/tauri.conf.json`。2.0.0 起发行包中的启动程序为 `Music-Lab.exe`，还包含固定 Node 运行时、三平台 Provider、协议及完整依赖许可。Debug 保持上述开发路径。不要打包运行过的目录，以免带入日志和个人数据；Release 需提供对应源码并说明实际验证范围。
