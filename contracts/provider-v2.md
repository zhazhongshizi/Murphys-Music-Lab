# 多 Provider 契约 v2（3a 宿主边界）

3d 增量：网易开启 setLiked/setSubscribed/addItems/removeItems，B站仅开启 addItems/removeItems；握手方法、capabilities 和新鲜详情 allowedActions 同步。QQ v1 与 SQL schema 12 不变。

桌面公开 `provider_write({request})` 和 `provider_verify_write({request})` 使用 `ProviderWriteRequest={providerId,accountId,operation}`。operation 严格区分 setLiked(trackId,liked)、setSubscribed(containerId,subscribed)、addItems/removeItems(containerId,trackIds)，输入最多100，身份须同来源；拒绝未知字段。accountId 为公开目标账号，generation 仅由宿主接收时捕获。B站分 P 输入归并为 RawWriteItem video/bvid，网易为 song/songId。`provider_read` 仍为显式只读白名单，新命令不注册 Remote。

新增私有只读方法：`library.container({containerId}) -> container`（新鲜权限详情）；`library.verify({method,params}) -> writeReceipt`（仅四个已定义写方法及对应严格 params 的联合，不发送任何写请求）；网易 `library.likeIds({}) -> string[]`（完整 raw ID、最多100000）。对应公开 `provider_likes` 仅 ready 读取、返回 `{accountId,ids}` 规范 ID。完整读回不依赖歌曲详情第一页。所有新增 schema、TS 类型与 fixture 同步，未知嵌套字段拒绝。

结果映射：发送前校验/权限/未 ready 失败为固定错误、零写请求；可信 no-op 或发送后读回完全满足为 `applied,affectedCount:null`；已发送后响应丢失、HTTP/平台错误或成功响应后读回失败/不一致为 `verificationPending,affectedCount:null`。`outcome_unknown` 表示不能证明未发送；不转换成可自动重试的普通网络失败。Client 从 begin 成功后的 Timeout/Unavailable/Stale/协议失败，在写入语境映射 outcome_unknown；宿主转为 pending，进程不重启。写超时/取消回收进程，迟到结果不应用到新账号。可以证明 begin 前失败的路径保留明确错误。只读核对失败保留固定错误或 pending，不宣布 applied。

UI/宿主均按平台+账号+目标互斥；宿主对未知写入保留当前代次指纹，只允许相同动作的只读核对。核实后清除；退出/故障移除本来源缓存和未决指纹。Node 接收时捕获 epoch、发送前再次检查，写调度不合并不重试；只读合并另带写修订，写后读取不能复用写前结果。网易 playlist_tracks 原始隐式重发分支已加载时移除，实际模块/HTTP 路径计数验证；无刷新、重扫码或 5xx 自动补发。

喜欢缓存按 QQ 与网易账号分别维护。完整网易读取的代次+修订必须仍有效，写后已核实增量才合并；未知写结果不加权。QQ 退出/旧全量读取不抹掉网易，网易退出不抹掉 QQ，B站无歌曲喜欢。写入行为与权限见 [网易写入说明](../providers/node/netease/WRITES.md)。

3c 增量：Bilibili 已使用独立生产入口 `providers/node/bilibili/main.mjs`。私有 `resolution` 显式增加可选 `backupUrls`（最多 8 个、唯一 HTTPS 字符串）；带此字段必须为 `videoPart`、`quality=aac`、`codec=aac`。网易旧单 URL 载荷保持有效；QQ v1 不变。Rust 校验所有候选的域名/DNS/端口与固定 headers，首次成功 GET 后不再换候选；URL/headers/备用列表均不进入公开 DTO。

同载荷可选 `dash={initialization,indexRange}` 仅对 B 站 AAC 有效；来自该 audio 项的 `SegmentBase`（兼容 snake_case），两个十进制字节范围经 Rust 校验顺序、初始化从 0 开始、各范围小于 1 MiB 且结尾小于 2 MiB。媒体桥据此生成只引用自身随机音轨句柄的音频 MPD，交给现有 Windows `MediaSource.CreateFromUri` 自适应读取；不接受上游 XML/外部清单 URL、不改写音频、不转码。缺失 SegmentBase 的旧载荷仍可使用原始流路径，类型与宿主严格校验不变。

桌面受控 `provider_check` 调用已声明的私有 `auth.credential.check`，仅 ready 平台允许，公开返回 boolean。Registry 对该 authenticated 方法单独准入，valid=false 立即按 CredentialInvalid 收尾；不会将其他认证方法作为任意业务转发，也不会自动检查/续签或删除保存材料。

`video.durationMs` 表示视频全部分 P 的总时长，上限调整为 `864000000000`（最多 10000 个、各 24h 分 P 的总上界），用于正常超过 24h 的课程合集；`track.durationMs` 与 `resolution.durationMs` 单 P 上限仍为 `86400000`。未制造或截断时长。

队列/历史/私人集合公开 `video: {title,partTitle,partNumber}`，B 站规范分 P 必需、其他来源拒绝。SQL schema 12 保存分 P 身份与展示信息，并沿用升级前备份入口。公开播放载荷 `quality=aac` 必须携带 `bitrate`（1..100000000），会话同理为 `actualQuality=aac` 与 `actualBitrate`；旧音质载荷不新增字段。

本文与 schema、类型及共享 fixture 定义当前多来源宿主边界。Registry、独立 Rust v2 客户端、代次协调存储与两个生产 Node Provider 已接通；QQ 保留惰性生产宿主。测试探针不注册为生产 Provider，合成测试不替代真实账号与播放验收。参见 [架构说明](../docs/architecture.md)。

## 文件与职责

| 文件 | 用途 |
| --- | --- |
| `protocol-v2.schema.json` | 私有帧、逐方法 params/result 的严格 schema |
| `protocol-v2.constants.json` | 帧限制、平台名称、能力 profile、方法权限及重放语义 |
| `provider-v2.ts` | 新 Node Provider 的私有请求/响应类型；禁止 renderer 生产代码导入 |
| `providers-public.schema.json` | renderer-safe DTO，与私有 credential/media 响应分离 |
| `../src/contracts/providers.ts` | 公开 DTO，作为后续新入口的类型，不改变当前旧入口 |
| `../src/contracts/providerIdentity.ts` | 前端共享身份编解码 |
| `../src-tauri/src/multi_provider/` | 身份、能力、错误、纯 reducer、Registry、v2 客户端、QQ v1 惰性宿主与 DPAPI/代次存储 |
| `../tests/fixtures/provider-v2/` | TS/Rust/Python 共同使用的身份、生命周期、方法交互和公开 DTO 样例 |

schema 为载荷形状的真相源，constants 为方法和平台 profile 的真相源。修改须同步类型及 fixture。schema 校验不能替代下面的上下文/网络策略校验。

## 传输与关联

- 独立进程固定一个来源。QQ 保持 v1；网易和 B 站为 v2。不降级、不由响应自行决定协议版本。
- UTF-8 NDJSON，每行一个对象，去掉 LF 或 CRLF 后最多 1,048,576 bytes；嵌套最多 128。禁止 BOM、空行、重复 JSON key、非有限数字和无效 UTF-8。`v` 必须是整数词法 `2`，不是 `2.0` 或 `2e0`。这些必须由后续 decoder 执行，JSON Schema 无法表达全部词法规则。
- 第一帧必须为 `system.handshake`，请求明确 `protocolVersion:2` 和来源。宿主核对注册的来源、provider name、精确版本、帧上限、方法与能力。constants 的 profile 是平台能力上界；`Registration::with_profile` 可注册已实现的子集（3b/3c 不宣告写能力），方法必须覆盖实际宣告能力。不能接受其他来源的名称/能力组合。
- 请求 ID 为 constants 中的 ASCII 模式；进程存活期间不得重复。响应可以乱序，宿主用 pending request 的 method 选择 result schema；不能只校验 success envelope。未知/重复响应 ID 是协议故障。
- 成功始终含 `warnings` 数组；仅结构化白名单 warning，无原始正文。错误含枚举 `code` 与 `retryable`，可选 `retryAfterMs` 为 0–86,400,000 的整数，只来自平台适配器已核实的冷却提示，不含原始异常字符串。宿主按单调时钟计算剩余冷却，在 disabled snapshot 公开剩余 `retryAfterMs`；没有提示时不凭空统一设置间隔，不持久化封禁。
- 只有 `auth.qr.progress` 和 `provider.invalidated` 事件。成功扫码的 credential 只在对应 `auth.qr.poll` 终态响应返回，progress 不携带 credential 或登录成功终态，避免双重保存。
- stdout 仅帧；stderr 仅脱敏诊断。`method_not_found` 不作为开放代理入口；未知方法在 request 校验时拒绝。
- `readOnly` 表示具备只读语义，不等于允许自动启动 Provider 或无限重试。读取须保持同账号代次并受既有有界策略控制。`neverReplay` 即使收到 retryable 错误也不得自动重发，包括全部写入、扫码操作、恢复和刷新。

## 方法与数据流

全部方法的精确字段见 constants 对应的 `$defs/<params|result>`。分页显式传 `page`（1 起）、`pageSize`（1–100）；返回 `page/hasMore/total/items`，未知总数用 null。不得把缺失 total 解释为零。返回数量不得超过请求 pageSize，返回 page 必须匹配；由宿主/Provider 的上下文验证负责。

| 方法组 | 方法 | 来源及用途 |
| --- | --- | --- |
| 握手 | `system.handshake`, `system.ping` | 两来源；只能操作已由宿主启动的进程 |
| 扫码 | `auth.qr.start/poll/cancel` | 两来源；每进程一个有效 QR session，返回局部不透明 sessionId |
| 恢复 | `auth.credential.restore/check` | 两来源；restore 只有检查凭据有效后才返回 account，失效用 credential_invalid |
| 刷新 | `auth.credential.refresh` | 仅网易；原子替换秘密材料；B 站不宣告或调用此方法 |
| 退出 | `auth.logout` | 两来源；上游失败不阻止宿主执行本地退出 |
| 搜索 | `search.songs/playlists`、`search.videos` | 网易歌曲/歌单、B 站视频 |
| 详情 | `song.detail`、`video.resolve`、`video.parts` | 网易歌曲；B 站链接/BV/AV 解析、分页分 P |
| 曲库 | `library.containers`、`library.tracks/videos`、`library.likes` | 两来源容器，网易歌曲/B 站视频，网易喜欢列表 |
| 喜欢/订阅 | `library.setLiked/setSubscribed` | 仅网易；boolean 表达目标状态 |
| 容器写入 | `library.addItems/removeItems` | 网易 songId 或 B 站 bvid，不可混合来源或资源种类；每次 1–100 个唯一项目 |
| 歌词 | `lyrics.get` | 仅网易；原文/翻译/罗马音 LRC，缺失用 null |
| 播放 | `playback.resolve` | raw song 或 videoPart；B 站只接受 auto/aac，网易只接受 auto/flac/320k/128k |

私有 payload 的原始数字 ID 一律为十进制字符串，1–20 位，不为 0，不带前导零；不得转换为 JS Number。BVID 保持规范大小写及 Base58 字符集。与平台来源、请求对象相关的响应字段必须逐项核对，不能接受别的 songId/bvid/cid/containerId。

B 站搜索和收藏夹返回 video summary，不为每个列表条目预取分 P。选播/入队时调用 `video.parts`，默认第一 P；批量展开按 page 顺序获取，每批复核播放/账号意图。track identity 只有获取 CID 后生成。收藏增删使用 bvid，不接受 videoPart；宿主将同视频多 P 去重后提交，Provider 再解析所需 aid。

B 站可播放 track 的 `video` 必须保留原始 `title`（视频标题）、`partTitle`（分 P 标题）和从 1 开始的 `partNumber`；外层 title 为分 P 标题，creatorKind 为 uploader，album 为空。公开 `ProviderVideo` 仅用于浏览，不能当作 TrackRef 入队。失效条目的 availability 区分 deleted、permissionDenied、processing 和 noAudio；无法判定才用 unavailable，不把猜测当成平台明确状态。

`library.addItems/removeItems` 完成后读回核对：确认全部应用返回 applied；读回不确定返回 verificationPending。请求可能已提交但无法收到结果，返回 outcome_unknown，retryable=false。不能在 SDK 内重新发送写入；只有用户核对后重新操作。

媒体解析结果含 raw track、实际 quality/codec/bitrate、HTTPS URL、允许的 Referer/User-Agent、有效期秒数及媒体时长。B 站必须是 AAC；没有可用音轨返回 unsupported_media。不在解析结果发送 Cookie、Authorization 或任意请求头。域名/DNS/重定向/请求头值的完整安全校验归后续 Rust 媒体桥，schema 的 HTTPS 前缀检查不代表已可信。

3c 审阅 F1：B站 `expiresInSeconds=0` 明确表示**没有适配器验证过的硬期限**，宿主不为它建立过期计时器；不能把建议缓存时长或未经核实的 URL 查询参数当作资源失效。当前 B站适配器只返回 0。正数仍代表已确认的硬期限，保留原有一次恢复上限；未知期限的资源只在真实播放失败后消耗同一意图的一次恢复预算。网易既有正数有效期行为不变。公开播放结果允许此 0，但不公开媒体 URL。

网易只返回试听片段时以 preview_only 报告，不把片段作为完整歌曲成功解析；权益不足用 entitlement_denied，资源不可用用 media_unavailable。播放成功不代表全平台“无损”，实际 codec/bitrate/quality 必须取返回值。

credential 为 `{version:1, providerId, payload}`；payload 是由所属适配器解释的 JSON 文本，宿主视为秘密材料。完整序列化 envelope 的 UTF-8 长度最多 64 KiB（不是 JS 字符数）；schema 字符上限只是初筛。不得输出 Debug/日志。恢复时必须匹配所属 Provider，之后才可传入子进程。

## 公开 DTO 与旧数据

- 新入口返回显式 providerId；3a 已给现有 catalog 曲目、队列、历史与播放器曲目投影补派生来源，前端严格白名单同步。QQ 私有 v1 与 auth 载荷不变。旧 QQ/local 请求兼容缺来源；新平台请求必须明确来源且匹配规范 ID。缓存键、请求 ID 与歌手/专辑 ID 不按曲目放宽。
- public TrackRef 请求必须给 providerId，宿主重新验证来源和 ID。只有旧持久化读回允许使用 `from_legacy_id`/`decodeTrackRef(id)` 推导来源。
- QQ 裸 MID 保持现有 ASCII 字母数字、下划线和短横线规则（1–128 bytes）。`local_` 是保留前缀：必须匹配 64 位小写十六进制摘要和 mp3/flac/ogg，否则拒绝，不能退回当 QQ。
- 新身份为 `netease:track:<songId>`、`bilibili:video:<bvid>:<cid>`。容器身份另为 `netease:playlist:<id>`、`bilibili:favorite:<id>`，不得进入播放队列。
- 公开 Track、Container 仅含元数据、来源、cache key 和能力；private coverUrl 必须先由 Rust 处理，再转为 public coverCacheKey。不得直接将私有结果当公开对象。
- account 内 providerId 必须等于所属 snapshot/container；容器 kind 与来源对应，只有当前账号创建的容器可宣告增删能力；collected 容器不能因“已登录”变成可编辑。
- public ready snapshot 必须有 account 和 persistence。保存失败用 sessionOnly，不把已登录误报为未登录。非 ready 不展示旧 account。
- public capability 支持 QQ 原有 artists/albums 与歌单 create/delete；新平台静态 profile 不包含这些。QQ 原能力仍由 v1 adapter 保留，不在本阶段重写。
- Schema 11、sidecar 表结构与旧 ID 不迁移。SQL 继续使用原 ID；旧 QQ/local 私人队列 JSON 写入保留旧字段集，公开投影补来源；新来源 JSON 必须存显式 providerId。隔离夹具覆盖队列、历史、恢复位置、私人队列/previous/删除撤销、整理计划、MV 偏移、统计、metadata cache 与 sidecar。含新来源的 JSON 不承诺被 1.3.3 读取，回退使用匹配的升级前主库/sidecar 快照并另存新数据。

## 生命周期 reducer 与宿主执行约定

Rust Lifecycle 是纯状态机：只返回 generation 与 effects，不启动进程、不读凭据、不发送请求。后续 Registry 每个在线平台持有独立实例，不能共享 generation、QR session 或恢复锁。

| 输入/条件 | 状态与效果 |
| --- | --- |
| 启动恢复且无凭据 | 保持 disabled，无 effect |
| 用户登录/有凭据恢复 | disabled→starting，递增 generation，StartProcess |
| 当前进程握手成功 | starting→authenticating/restoring |
| 同代次认证成功，账号来源正确 | →ready；保存成功 saved，否则 sessionOnly |
| 取消/过期/拒绝/网络失败/凭据失效/进程故障 | →stopping；递增 generation，InvalidateSession、StopProcess，保留已有凭据 |
| 显式退出 | →stopping；InvalidateSession、DeleteCredential、StopProcess |
| 退出应用 | 停进程并失效当前会话，保留凭据供下次恢复 |
| 所属进程实际退出 | stopping→disabled；无自动再启动 |
| 旧 generation 回调 | 丢弃，无 effect，不改变状态 |

InvalidateSession 由宿主执行：停止该来源正在播放的媒体、撤销其媒体句柄、使私有缓存与异步结果失效；不清空混合队列/历史，不操作其他平台。取消旧二维码只作用于已捕获的 generation/sessionId，不能取消新会话。

QR 取消、过期与拒绝走 `cancel_auth`；ready 后到达的同代次 QR 终止通知也忽略。`fail` 用于真正的进程/会话失效，不能拿迟到的扫码通知调用它。StopProcess 的完成通知使用停止 transition 返回的 generation，不能沿用已经失效的启动代次。

业务请求仅 ready 放行；system.ping 不得借机启动 disabled 平台。声明能力不是执行授权。restore 失败保留 credential 文件，明确失效时不后台反复验证；用户点重试才开始新代次。新平台 max_restarts 固定为 0；QQ 保留受停止意图约束的恢复，恢复后的握手不直接恢复账号 ready，也不重放失效请求。

认证保存分为可取消的 prepare（加密/临时写入/flush）与最终 commit。最终代次检查、提交和 ready 发布在平台状态锁内完成，QR 取消与该提交有确定先后：prepare 中的有效取消阻止落盘；已经进入提交的认证先完成为 ready，迟到取消忽略。显式退出仍须等待正在提交的保存并删除，删除未结束前不允许新登录；主动关闭/迟到退出通知不能提前完成该删除。删除失败返回错误。`register_dpapi` 是生产新平台注册入口，路径为 `<app-data>/provider-state/<providerId>/credentials.v1.dpapi`；当前用户 DPAPI、UI_FORBIDDEN、无可选熵（加解密均 None）。保存失败继续 sessionOnly，文案见 `src/contracts/providerErrors.ts`。

## 错误与后续验证

errors 枚举覆盖参数、能力、登录、凭据失效、网络/限流、权益、媒体不可用/不支持、上游形状变化、Provider 故障、写结果不确定、读回未确认、取消和内部错误。UI 按 code 使用本地文案。网络失败不等同 credential_invalid；outcome_unknown/verification_failed 不能变成自动写重试。

共享 fixture 的 URL 全部为 `.invalid`，秘密字段仅合成材料。schema 测试不访问网络、不校验真实登录或播放。3a 的 Rust unit/真实假子进程测试已经覆盖严格词法与方法载荷、关联/取消/超时/迟到、进程退出、DPAPI 与保存竞态；真实账号、生产媒体与桌面验收仍不由这些测试代替。
