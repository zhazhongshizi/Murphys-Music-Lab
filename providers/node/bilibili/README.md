# Bilibili 生产 Provider（3c–3d）

入口 `main.mjs` 是独立 NDJSON 子进程；与网易共用固定磁盘 Node，实例、CookieJar、WBI 缓存、请求合并和账号代次分别持有。无凭据时 Registry 不启动进程、不请求平台。二维码临时启动，取消/过期/故障由 Registry 回收；只有确认 nav 账号后才 ready。3d 增加向已有自建收藏夹增删视频，没有 HTTP 服务、静默续签、下载、转码或视频流。

## 固定资源与来源

- Node `24.22.2`，清单与 SHA-256 在 [runtime.json](../runtime.json)。开发路径：`output/node-24.22.2/bundled/node-v24.22.2-win-x64/node.exe`；未来 portable 为 `node/node.exe`，本阶段未打包。
- 直接依赖：`ajv@8.17.1`、`qrcode@1.5.4`、`tough-cookie@5.1.2`；`package-lock.json` 固定全部 37 个安装包及 tarball integrity。用固定 Node 的 npm 执行 `npm ci --ignore-scripts --no-audit --no-fund`，不依赖网易包目录。
- 接口/响应/WBI：BBPlayer [`e2e7f52759ad8c79f54ab28021b43df473f849ed`](https://github.com/bbplayer-app/BBPlayer/tree/e2e7f52759ad8c79f54ab28021b43df473f849ed)，已读取 API、client、WBI、types 文件；原始文本、MIT 版权与文件路径在 `reference/`、`reference-lock.json`。不加载这些参考文本，不引入移动播放器/遥测/下载代码。WBI 两个 key 都去扩展名，签名使用固定测试向量，不自动校时。
- 流桥参考：bili-music [`94ef03bb97d9ae3117f2f08c3255f17714b61dc3/src-tauri/src/proxy.rs`](https://github.com/Jmiao11/bili-music/blob/94ef03bb97d9ae3117f2f08c3255f17714b61dc3/src-tauri/src/proxy.rs)，原文本/许可在 `reference/`。复用本项目生产 `MediaBridge`，不引入上游 CORS/LAN/下载/本地文件服务与原始错误日志。
- 依赖来源、精确版本、SPDX、完整性与全部许可文本在 `dependency-notices.json`、`licenses/`。资源检查：`node providers/node/bilibili/verify-resources.mjs`。

## 方法、数据与安全边界

握手：`bilibili-provider` / `0.1.0` / protocol 2，实际 18 个方法：

```text
system.handshake system.ping
auth.qr.start auth.qr.poll auth.qr.cancel
auth.credential.restore auth.credential.check auth.logout
search.videos video.resolve video.parts
library.containers library.videos playback.resolve
library.container library.verify library.addItems library.removeItems
```

`writeActions=[favorite.addVideos,favorite.removeVideos]`、`lyrics=false`、`qualities=[auto,aac]`。只读方法按账号 epoch 与写入修订串行调度、同参数在途合并；真实 NDJSON 管道并发帧测试覆盖，不后台翻页。风控/限流阻止本实例继续自动请求；网络失败不判凭据失效。日志只输出固定错误码，无响应体/Cookie/二维码材料。

Cookie 由 tough-cookie 处理每条 `Headers.getSetCookie()`，支持 Expires 逗号、Domain/hostOnly/Path/Secure、覆盖与失效，拒绝错误域和公共后缀。只持久化恢复所需 Cookie；不保存二维码 key/refresh_token、不续签。凭据经独立 `<app-data>/provider-state/bilibili/credentials.v1.dpapi` 保存，64 KiB envelope 上限。恢复/检查通过 nav 确认账号，失效要求重扫码；网络/风控保留已保存材料。

自建目录使用 list-all，按请求页本地切片；owner 来自响应 `mid`。收藏目录使用 collected/list 的 `upper.mid`，只保留收藏夹（attr 的文件夹位），过滤同接口混入的合集；分页 has_more 保留，不用过滤后数量猜页。目录列表不授予写权限；显式详情重新核对后给出 allowedActions。收藏夹内容按普通视频展示，保留可识别失效条目的 availability；无规范 BV 的坏行省略，不伪造 CID。

输入只接受 BV、AV、标准视频 URL 和 b23.tv。AV 通过 view 取得规范 BV；标准链接只本地解析；短链每跳验证精确主机/协议/路径/端口，最多 3 跳，拒绝登录页/任意 URL/环路。b23.tv DNS 全部地址排除私网/回环/链路本地，连接固定已验证地址且保留 TLS 主机校验；遵循现有 TUN fake-IP 使用场景。短链请求无账号 Cookie。

视频摘要不是 TrackRef，不能直接入队。`video.parts` 生成 `bilibili:video:<bvid>:<cid>` 和完整 `video={title,partTitle,partNumber}`；保留 UP 与原始标题，分 P 顺序、CID 唯一性校验。无歌词返回正常空行，不查询其他平台。schema 12 保存分 P 身份与展示信息，见 [宿主契约](../../../contracts/provider-v2.md)。视频总时长可超过一天，单 P 仍按 24h 契约。

音轨只选 `audio/mp4`、`mp4a.40.2` 的最高合法 AAC。主/备用来自同一个 DASH audio 项；私有 `backupUrls` 为显式严格协议扩展。Rust 仅允许 `.bilivideo.com`、`.bilivideo.cn` 和 `upos-hz-mirrorakam.akamaized.net`（沿用第二步公开样例/参考 allowlist，未扩大 PCDN）；逐个校验 DNS/端口/请求头，拒绝重定向，CDN 不带 Cookie。首次 GET 成功即固定候选，之后失败走同播放意图一次重解析预算；不跨流续接字节。AAC 与实际 bps 在公开播放快照中保存，URL/headers 不进入队列、历史或 renderer。

有 `SegmentBase` 时同步携带私有 dash 初始化/索引范围。Rust 验证数字范围后在同一个回环桥提供仅含音轨的 MPD；原生播放器按 DASH 索引 seek，无转码/下载/整曲缓存。响应 206 缺少 Accept-Ranges 时补 `bytes`；已知 AAC 的 `application/octet-stream` 规范为 `audio/mp4`。公开长分 P 已实测通过，详见验证记录；不把裸 fragmented MP4 的慢扫描当作成功验收。

3c 审阅修复：API 未提供本适配器验证过的媒体硬期限，`expiresInSeconds=0` 表示未知，正常播放/暂停/继续不因时间经过而消耗恢复预算；不从未经核实的 URL 参数猜期限，也不把缓存 TTL 当作资源失效。实际网络失败与可信过期仍共用同一播放意图一次恢复上限。首次成功 GET 前对网络错误或上游 500–599 逐候选有限尝试；成功交付后固定资源，重定向、策略违规和 416 不触发此回退。简介按最多 4096 字符的多行文本保留 LF/CRLF，标题规则不变。数字选 P 只取目标页；整组才按 1000 首容量检查，取齐后单次提交。

## 3d 收藏写入

固定参考没有变化，没有新增包或许可。`reference/api.ts.txt` 的 `dealFavoriteForOneVideo` 使用 POST `/x/v3/fav/resource/deal`，参数 `rid=aid,type=2,add_media_ids,del_media_ids`；`batchDeleteFavoriteResources` 附近的实现使用 POST `/x/v3/fav/resource/batch-del`，`resources=aid:2,...,media_id,platform=web`。当前适配器先 view(bvid) 核对返回 BV 与 aid，不采用 UI 的 aid 或自行换算。宿主先将多个 CID 归并为 BV；队列分 P 原样保留。添加按每个视频最多一个 POST，移出按核实的批量接口一次 POST，1..100 个公开曲目输入。部分提交失败即停止，已提交项不重放，也不称远端原子事务。

发送前 nav 的 `data.isLogin=true`、`data.mid` 必须与已确认账号一致。权限详情来自 resource/list 的 `data.info.id`、`data.info.upper.mid`（固定 `reference/types.ts.txt` 的 BilibiliFavoriteListContents）；若 info.mid 存在必须与 upper.mid 一致。并要求当前账号 `created/list-all(up_mid=account)` 中有同 mediaId；其 mid/upper.mid 若存在必须一致。固定接口没有独立通用 canEdit 字段，本项目只对“详情 owner 一致且仍在本人自建列表”的容器授予 add/remove，拒绝共享/收藏他人容器、字段缺失或冲突。宿主以 library.container 复核，Provider 发送前再次权威读取。列表标签不构成编辑证据，allowedActions 只在新鲜详情开放。

CookieJar 在 API 写入路径上查找唯一有效的 32 位十六进制 bili_jct；缺失、过期或冲突立即拒绝。Token 仅进入固定 POST 的 form-urlencoded body，Cookie 仍在私有 transport 内；不进入 renderer、命令行、SQLite 或日志。写路径与 GET 白名单分开，固定 method/encoding，无重定向/重试/媒体桥 5xx 备用。

完整成员核对使用参考中的 `/x/v3/fav/resource/ids?media_id=...`（BilibiliFavoriteListAllContents：type=2 视频，id 为 aid），该接口一次返回完整相关收藏夹 ID，而非只读第一页，也不扫描不相关曲库。仅核对视频本体 aid，不用 CID。数组上限 100000、HTTP 响应上限 1 MiB，超出在发送前失败或发送后待核对。代码为 0/HTTP 200 仍必须读回全部目标状态；`success_num` 不代替结果核对。

已满足状态及成功读回均 `applied,affectedCount:null`；发送前验证错误不写，已发送后的超时/断连/拒绝/读回失败或不一致均 `verificationPending,null`。批量 pending 可包含部分完成；不能从请求数推断实际影响数。`library.verify` 独立只读、一次核对、不轮询；重复未知操作被宿主当前代次指纹阻挡。退出/故障清理该来源缓存，不重放排队动作；已发送远端结果不能撤销。接口边界见 [宿主契约](../../../contracts/provider-v2.md)，合成测试不代表真实账号验收。

## 验证和后续入口

在根目录用固定 node.exe 执行：

```powershell
& 'output/node-24.22.2/bundled/node-v24.22.2-win-x64/node.exe' --test providers/node/bilibili/tests/provider.test.mjs providers/node/tests/bilibili-audio.test.mjs
cargo test --manifest-path src-tauri/Cargo.toml --lib bilibili --offline
```

桌面受控入口为已注册的 `provider_login/poll/cancel/restore/check/logout/read`（providerId=bilibili），renderer adapter 为 `src/backend/providersAdapter.ts`。手动 `provider_check` 只返回布尔值，不后台轮询；确认 valid=false 与 credential_invalid 一样立即回收该来源 ready 代次并保留保存材料，其他账号不受影响。`nativeProviderEnqueueVideo(input, 'first'|'all'|partNumber)` 先取详情/分 P、核对当前账号，再单次整组入队；单 P 也可用 `nativeProviderEnqueueTrack`。完整普通/莱茵/Mini 浏览留 E，Remote 未注册认证/新来源业务读写；共享队列快照可解析 AAC/分 P。

独立原生探针（手动、静音、不访问用户库/凭据）：

```powershell
cargo build --manifest-path src-tauri/Cargo.toml --features manual-spikes --bin bilibili-production-probe --offline
# 必须等构建完成后再运行，不能与同一路径探针构建重叠。
& 'src-tauri/target/debug/bilibili-production-probe.exe' --public-probe BV1fK4y1t7hj 1
```

`tests/public-native-entry.mjs` 只在明确 probe 参数下允许公开 nav/view/pagelist/playurl；用合成认证让真实 Registry→Provider→Controller→流桥→Windows 解码路径可测。它不是生产注册入口、不能用于真实登录/私人收藏夹验收。仅输出码率/时长/seek/Ended 等摘要，媒体不落盘。真实账号、私人曲库和听音效果须独立验收。
