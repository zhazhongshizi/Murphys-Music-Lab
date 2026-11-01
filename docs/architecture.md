# 架构说明

Murphy’s Music Lab 2.0 的 React 界面通过类型化 Tauri IPC 提交 ID、枚举与用户意图。Rust 负责认证、凭据、混合来源队列、事务化 SQLite、原生播放器和 Windows 集成。QQ 音乐使用 Python Provider 和既有 v1 协议，网易云与 Bilibili 使用固定 Node.js 运行时和 v2 NDJSON 协议，各来源独立管理账号、能力和会话代次。

- 凭据由 Rust 管理：QQ 使用 Windows Credential Manager，新来源使用用户范围 DPAPI 保护；前端不获取 Cookie、密码或限时媒体 URL。
- 两套界面共用队列／播放器会话，异步请求使用代次与会话身份防止旧结果覆盖。
- Provider 不接受前端指定的任意 URL、请求头或远端方法。
- 本地文件、媒体与封面分别使用现有校验入口。诊断只输出受控事件和公开错误类别。
- Remote 提供局域网受控操作，使用连接码及 Host／Origin 等边界。

`ArchiveCanvas` 管理场景加载、销毁、可见性与共享帧数限制；3D／2D 复用交互和状态适配。稳定场景休眠，隐藏暂停。3D 使用 Three.js 与可选 AO／景深／SMAA，FSR 1 位于输出末端：低内部尺寸 → 显示编码 → EASU → RCAS → 目标画布。HTML 控件不进入超分，2D 材质是近似效果。

`vendor/rhine/src/` 为源码，`pnpm build:rhine` 生成被忽略的 `src/features/rhine/vendor/`。

| 入口 | 职责 |
| --- | --- |
| `src/features/`、`src/backend/` | UI 与类型化 IPC 适配 |
| `src-tauri/src/commands/` | 按功能组织的 IPC |
| `src-tauri/src/credentials.rs` | Windows 凭据与 secret blob |
| `src-tauri/src/persistence.rs` | SQLite schema 与事务 |
| `provider/qqmusic_provider/` | 认证、目录、播放及协议 |
| `providers/node/`、`src-tauri/src/multi_provider/` | 网易/B站Provider、协议边界、会话与媒体桥 |
| `contracts/`、`tests/fixtures/` | 协议与虚构测试样例 |
