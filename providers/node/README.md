# Node Provider 第二步探针

当前生产实现入口：[网易 Provider](netease/README.md)、[Bilibili Provider](bilibili/README.md)，3d 增加受控云端写入。下方描述第二步隔离探针及当时边界；探针本身仍不注册为生产平台。生产注册、私有流桥、分 P/AAC 与验证以两份 README 及最新 HANDOFF 为准。

这是 `codex/multi-provider-integration` 的隔离技术验证，不是可用的新平台 Provider。普通 GUI 不引用此目录，也不会因此启动 Node 或请求在线曲库。

## 运行与验证

在仓库根目录执行：

```powershell
# 下载/复用官方 ZIP；提取前校验归档，每次校验 node.exe，返回独立运行时路径
./scripts/bootstrap-node-runtime.ps1
# 离线：双平台握手、帧规则、固定上游扫码响应、WBI 与 AAC 筛选
./scripts/test-provider-stage2.ps1
# 验证真实子进程的响应符合冻结 schema（需先准备运行时）
provider/.venv/Scripts/python.exe -m pytest provider/tests/test_node_provider_probe.py -q
# 构建并验证独立 Rust 原生探针，不构建 qqmusic-gui.exe
cargo test --manifest-path src-tauri/Cargo.toml --features manual-spikes --lib multi_provider::media_probe --locked
cargo build --manifest-path src-tauri/Cargo.toml --features manual-spikes --bin provider-media-probe --locked
# 明确联网：公开 B 站样例 → 私有 stdin → Rust 流桥 → Windows 原生播放器（静音）
./scripts/test-provider-stage2.ps1 -PublicMedia
```

`runtime.json` 固定 Windows x64 Node 24.22.2、官方 URL 和 SHA-256；完整 ZIP/许可证保存在忽略的 `output/node-24.22.2/`。与系统 Node、Codex 自带运行时分别管理。探针不需要 npm install，也没有新增 Node 依赖；扫码 adapter 的类型检查使用项目已有 TypeScript。

`handshake-probe.mjs` 只实现握手和 ping，返回的 implementedMethods 明确限于这两项。静态 capability profile 用于检查协议形状，不能据此把探针注册为 ready 平台。测试使用绝对 node.exe 路径并清空 PATH，验证不依赖系统 Node/Python。

## 上游来源与小补丁

- 网易基线：[API Enhanced 4.41.1 / 984cc021](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced/tree/984cc021b8598cf94c22134f32a8426887fb2de7)。`fixtures/upstream/netease/` 的三个 `.js.txt` 是原始扫码模块的离线测试输入；原 [MIT LICENSE](fixtures/upstream/netease/LICENSE) 保留。未加载上游 main、Express、解灰功能或真实请求模块。
- `netease/patch-qr-check.mjs` 校验原文件的完整 Git blob SHA `1f34cb09d0a81d3f1c9ca048fec4f4ac2b850411` 后应用单一补丁：异常分支不再引用未定义的 result，而抛出脱敏错误，不重发请求。基线漂移即拒绝应用。原始文件保持不变，测试实际执行补丁后的源码。
- `netease/qr.ts` 将 800/801/802/803 映射为 v2；803 必须再确认账号后才生成私有 credential，不把 Cookie 带入公开账号。完整 envelope 限 64 KiB。图片测试使用合成 PNG；上游 QRCode、option 工具由离线 stub 提供。**未验证真实扫码/登录/恢复，也未引入上游请求栈。**
- B 站接口与 WBI 置换参考：[BBPlayer e2e7f52](https://github.com/bbplayer-app/BBPlayer/tree/e2e7f52759ad8c79f54ab28021b43df473f849ed)，保留 [MIT LICENSE](fixtures/upstream/bilibili/LICENSE)。独立实现只包含本轮公开样例所需路径；两个 WBI 图片 key 都去掉扩展名，不沿用参考实现 sub_key 带扩展名的处理。固定向量用独立 Python hashlib/urllib.parse 核对。
- 公开样例 `BV1fK4y1t7hj` 来自参考项目 CDN 测试入口；不会访问用户账号/收藏夹。只选兼容 AAC-LC DASH（mp4a.40.2），按返回带宽选最高项，不用 FLAC/杜比/视频流回退。

## 私有数据与生产接入边界

`public-media-probe.mjs` 的 stdout 是临时媒体描述，仅供父进程通过内存管道传给 Rust stdin。**不要直接在终端运行、重定向至日志或保存为 fixture**；使用上述 PowerShell 入口，只输出无 URL 的验证结果。

Rust `media_probe`、loopback URL 构造入口和 `provider-media-probe.exe` 均受 `manual-spikes` 控制。普通 RemoteMediaUrl 仍只接受 HTTPS。桥只绑定 `127.0.0.1:0`，用随机句柄，并固定 Referer/User-Agent；不会转发来访 Cookie/Authorization。DNS 使用现有媒体的公网/TUN fake-IP 策略并固定解析地址；重定向拒绝。读取以流转发、不落盘，撤销会取消流。

已确认长度的越界 Range 在桥内产生带 Content-Range 的 416，兼容 B 站 CDN 缺失该头的情况；长度未知且上游 416 不完整时仍拒绝。此桥还没有账号代次/播放意图绑定、媒体过期重新解析及完整生产异常处理，不能直接接入发布包。

生产阶段仍须完成 Registry/supervisor、逐方法 schema 校验、异步响应关联、完整凭据存储、所有业务入口 ready gating、实际平台 API/登录、媒体过期恢复、UI 和 Remote。不要把本探针作为未登录在线访问的生产旁路。
