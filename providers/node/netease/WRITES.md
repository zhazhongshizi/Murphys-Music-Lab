# 3d 写入、权限证据与许可证

固定 API Enhanced 4.41.1 / `984cc021b8598cf94c22134f32a8426887fb2de7`，没有升级 Node 或依赖。新增 `like`、`playlist_subscribe`、`playlist_tracks`、`playlist_detail_dynamic` 原始文件均以 SHA-256 进入 [upstream-lock](upstream-lock.json)，沿用 [MIT 许可](upstream/LICENSE)。加载补丁见 [README](README.md)，不修改锁定原文件。接口文档的完整相关章节摘录、原行号、来源路径见 [reference/write-api-docs.txt](reference/write-api-docs.txt)，摘录自身哈希见 [reference-lock](reference-lock.json)。参考文本不参与执行。

## 请求与结果

| 方法 | 固定模块 / 上游路径 | 验证目标 |
| --- | --- | --- |
| library.setLiked | like / POST /weapi/radio/like；明确 `like=true/false` | likelist.body.ids 完整集合 |
| library.setSubscribed | playlist_subscribe / POST /eapi/playlist/subscribe 或 unsubscribe | playlist_detail_dynamic.body.subscribed 布尔状态 |
| library.addItems/removeItems | playlist_tracks / POST /eapi/playlist/manipulate/tracks；明确 add/del | playlist_detail.body.playlist.trackIds 完整集合 |

每次先以 login_status 的 `data.account.id` 确认当前账号；`data.profile` 必须存在。公开规范 ID 在宿主解码，歌曲只传 raw songId。批量 1..100，同来源、去重，宿主不接受 renderer 的 owner、URL、Cookie 或账号代次。

`playlist_detail` 固定源码设置 `n=100000`；固定文档明确 `trackIds` 完整而 `tracks` 可能不完整。因此核对只用 trackIds，不用第一页 tracks，也不额外获取歌曲详情。要求 `playlist.id` 匹配、`trackCount` 与 trackIds 长度一致且不超过 100000，缺失/截断则在发送前拒绝或发送后待核对。喜欢使用完整 likelist.ids；超过 100000 拒绝。订阅读取独立动态详情，不以旧列表标签做 toggle。HTTP adapter 每次直接发送加密 POST，没有外层 API 服务缓存，也没有重试。

## 权限路径与保守策略

容器详情 `body.playlist.creator.userId` 是 owner；若同时有 `body.playlist.userId`，必须与当前账号一致。再按当前账号 uid 分页读取 user_playlist（每页100、最多100页），直到同 ID 条目出现或列表终止；条目的 `creator.userId` 必须一致，若存在 `userId` 同样一致，`subscribed` 不得为 true。缺 owner、冲突、列表缺失、分页不完整、未登录均不授予内容编辑能力，零写请求。

该固定接口没有独立的通用 `canEdit` 字段。本适配器仅将“新鲜详情 owner 一致 + 当前账号自建列表中的同一容器”作为**自有容器编辑策略**，不推断协作者、共享歌单或收藏标签的编辑权；不伪造平台权限字段。列表的 allowedActions 继续为空，只有显式 `library.container` 重新核对后宣告 addTracks/removeTracks。宿主复核该 DTO，Provider 真正提交前再核对一次。这是接口与本项目策略的映射，真实账号权限验收仍待补。外部 owner 的歌单可宣告订阅/取消订阅，订阅不要求操作者拥有它。

## 不重发与缓存

确认目标已满足的 no-op 与写后读回确认均返回 `{status:applied,affectedCount:null}`，不编造本次改动数量。发送前失败抛固定错误；发送后异常、响应错误、读回失败/不一致均 `verificationPending,null`。`library.verify` 是独立只读路径，永不调用写模块。不无限轮询、不补偿、不重新登录后重放。风控不能用刷新 token 或换音源绕过。

同一目标跨入口在 UI 与宿主互斥；未知结果在当前账号代次保留指纹，重复提交拒绝，只允许核对同一目标动作。账号变化立即使队列中旧写入失效；已发送远端写入不承诺撤销。只读合并键包含写入修订，避免写后的读取合并到写前请求。账号失效/退出清理该来源内存缓存。

宿主 `provider_likes` 只在 ready 时读取完整规范 ID 集合，以代次+读取修订防止旧全量覆盖新写入。只有已核实的喜欢增量更新缓存与智能随机；QQ 与网易分开清理、合并使用，B站不获得歌曲喜欢权重。
