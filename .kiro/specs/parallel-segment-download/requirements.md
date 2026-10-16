# 需求文档

## 简介

本功能为海康威视 DVR 视频下载器添加并行分段下载能力。当前通过 RTSP 回放协议导出视频时，速度被限制在约 1 倍实时速率——导出 2 小时录像需要约 2 小时。

并行分段下载方案将请求的时间范围拆分为多个较短的片段，通过多个 RTSP 连接并发下载，裁剪重叠边界后拼接为单个输出文件。根据 DVR 的并发连接上限，可将导出时间缩短 3-6 倍。

## 术语表

- **Segment_Splitter（分段器）**: 负责将请求的时间范围拆分为多个带重叠的子范围的模块
- **Download_Manager（下载管理器）**: 负责编排并行 RTSP 下载并控制并发数的模块
- **Segment_Trimmer（裁剪器）**: 负责去除已下载片段开头重叠部分的模块
- **Concatenator（拼接器）**: 负责将裁剪后的片段合并为单个原始流文件的模块
- **Remuxer（封装器）**: 负责将拼接后的原始流转换为带正确时间戳的 MP4 文件的模块
- **DVR**: 海康威视数字硬盘录像机设备
- **RTSP_Connection（RTSP连接）**: 与 DVR 建立的单个实时流媒体协议回放会话
- **Overlap_Duration（重叠时长）**: 相邻片段之间的时间重叠秒数（默认 3 秒），可配置
- **Concurrency_Limit（并发上限）**: 允许的最大同时 RTSP 下载连接数（默认 4）
- **I_Frame（I帧）**: 视频流中的关键帧；RTSP 回放总是从最近的 I 帧开始
- **Annex_B**: 用于中间片段存储的原始 H.264/HEVC 字节流格式
- **Progress_Reporter（进度报告器）**: 基于 SSE 的机制，向前端报告下载状态

## 需求

### 需求 1：时间范围分段

**用户故事：** 作为用户，我希望系统自动将请求的时间范围拆分为较短的片段，以便并行下载从而缩短总导出时间。

#### 验收标准

1. WHEN 导出请求的时间跨度超过 60 秒, THE Segment_Splitter SHALL 将时间范围拆分为等长片段（默认每段 120 秒），最后一段覆盖剩余时间。
2. THE Segment_Splitter SHALL 为除第一段外的每个片段在开头增加 Overlap_Duration 秒，将其起始时间向前延伸。
3. THE Segment_Splitter SHALL 为除最后一段外的每个片段在结尾增加 Overlap_Duration 秒，将其结束时间向后延伸。
4. WHEN 导出请求的时间跨度为 60 秒或更短, THE Segment_Splitter SHALL 将整个范围作为单个片段处理，不进行拆分。
5. THE Segment_Splitter SHALL 生成对齐到整秒的片段时间边界（无亚秒精度）。
6. THE Segment_Splitter SHALL 接受可配置的片段时长参数，最小值为 30 秒。

### 需求 2：并行下载编排

**用户故事：** 作为用户，我希望片段能同时下载，以便总导出时间相比顺序下载显著缩短。

#### 验收标准

1. THE Download_Manager SHALL 并发下载片段，同时活跃的 RTSP_Connection 数量不超过 Concurrency_Limit。
2. THE Download_Manager SHALL 将 Concurrency_Limit 默认设为 4 个同时连接。
3. WHEN 某个片段下载失败, THE Download_Manager SHALL 对该失败片段最多重试 2 次后再报告错误。
4. WHEN 某个片段在所有重试后仍然失败, THE Download_Manager SHALL 中止剩余下载并向用户报告失败。
5. THE Download_Manager SHALL 将每个下载的片段作为独立的 Annex_B 格式文件存储在 downloads 目录中。
6. THE Download_Manager SHALL 从第一个片段检测视频编码格式（H.264 或 HEVC），并对所有片段应用相同的编码假设。
7. WHILE 片段正在下载, THE Download_Manager SHALL 跟踪各片段的进度并通过 Progress_Reporter 报告汇总进度。

### 需求 3：片段重叠裁剪

**用户故事：** 作为用户，我希望重叠部分从片段边界被裁剪掉，以便最终视频连续播放而不出现重复帧。

#### 验收标准

1. WHEN 所有片段下载完成, THE Segment_Trimmer SHALL 去除除第一段外每个片段开头的 Overlap_Duration 秒。
2. THE Segment_Trimmer SHALL 通过定位裁剪点处或之后的第一个 I_Frame 来执行裁剪，从该位置开始截取。
3. IF Segment_Trimmer 在预期裁剪点之后 2 秒内无法定位到 I_Frame, THEN THE Segment_Trimmer SHALL 在对应 Overlap_Duration 时间戳的最近字节边界处裁剪。
4. THE Segment_Trimmer SHALL 在裁剪过程中保持原始 Annex_B 格式，不进行重新编码。

### 需求 4：片段拼接

**用户故事：** 作为用户，我希望所有裁剪后的片段被合并为一个连续的视频文件，以便我获得一份完整的录像。

#### 验收标准

1. WHEN 所有片段裁剪完成, THE Concatenator SHALL 按时间顺序对 Annex_B 流执行二进制拼接。
2. THE Concatenator SHALL 输出单个 Annex_B 文件。
3. THE Concatenator SHALL 在成功拼接后删除各个片段文件。
4. IF 任何片段文件缺失或大小为零字节, THEN THE Concatenator SHALL 中止操作并报告错误，指明缺失的片段。

### 需求 5：最终封装

**用户故事：** 作为用户，我希望拼接后的视频被封装为标准 MP4 文件并具有正确的播放时间，以便我可以在任何播放器中播放。

#### 验收标准

1. WHEN 拼接完成, THE Remuxer SHALL 使用强制帧率 20 fps 将 Annex_B 流转换为 MP4 格式。
2. THE Remuxer SHALL 应用 faststart 标志以支持渐进式播放。
3. THE Remuxer SHALL 在成功封装后删除中间的拼接 Annex_B 文件。
4. WHEN 封装完成, THE Remuxer SHALL 通过 Progress_Reporter 报告完成状态和输出文件名。

### 需求 6：并行下载进度报告

**用户故事：** 作为用户，我希望在并行下载期间看到有意义的进度更新，以便了解导出进展和大致剩余时间。

#### 验收标准

1. WHILE 片段正在并行下载, THE Progress_Reporter SHALL 基于所有活跃片段已接收字节数占估计总量的比例，报告汇总进度百分比。
2. THE Progress_Reporter SHALL 在状态消息中显示当前阶段（分段中、下载中、裁剪中、拼接中、封装中）。
3. THE Progress_Reporter SHALL 报告哪些片段已完成、哪些仍在进行中。
4. WHEN 某个片段正在重试下载, THE Progress_Reporter SHALL 在状态消息中指示重试次数。

### 需求 7：并发安全

**用户故事：** 作为用户，我希望系统尊重 DVR 的连接限制，以便下载不会因超出设备容量而失败。

#### 验收标准

1. THE Download_Manager SHALL 确保任何时刻活跃的 RTSP_Connection 数量不超过 Concurrency_Limit。
2. WHEN 某个片段完成下载, THE Download_Manager SHALL 立即启动下一个排队的片段（如果还有剩余）。
3. THE Download_Manager SHALL 接受用户可配置的 Concurrency_Limit，有效范围为 1 到 8。
4. IF DVR 拒绝了某个 RTSP_Connection, THEN THE Download_Manager SHALL 将当前导出任务的 Concurrency_Limit 减 1 并重试被拒绝的片段。

### 需求 8：回退到顺序下载

**用户故事：** 作为用户，我希望当并行下载不可行时系统能回退到现有的单流下载方式，以便导出仍能成功完成。

#### 验收标准

1. WHEN 导出时间范围为 60 秒或更短, THE Download_Manager SHALL 使用现有的单流下载方式，不进行分段。
2. IF 所有并行下载尝试因连接被拒绝而失败, THEN THE Download_Manager SHALL 回退到单流顺序下载方式并通知用户。
3. WHEN 回退到顺序模式时, THE Progress_Reporter SHALL 指示系统正在使用单流模式。

### 需求 9：失败或取消时的清理

**用户故事：** 作为用户，我希望导出失败或被取消时中间文件能被清理，以免磁盘被部分下载的文件占满。

#### 验收标准

1. IF 导出在任何阶段失败, THEN THE Download_Manager SHALL 删除该次导出过程中创建的所有中间片段文件。
2. IF 用户取消导出, THEN THE Download_Manager SHALL 终止所有活跃的 RTSP_Connection 并删除所有中间片段文件。
3. THE Download_Manager SHALL 不删除已成功创建的最终 MP4 文件（如果在后续操作中发生失败）。

### 需求 10：API 接口

**用户故事：** 作为开发者，我希望并行下载功能通过现有 API 访问，以便前端可以触发和监控并行导出。

#### 验收标准

1. THE 现有 `/api/export` 端点 SHALL 接受可选的 `parallel` 布尔参数（默认值：true）以启用或禁用并行下载。
2. THE 现有 `/api/export` 端点 SHALL 接受可选的 `concurrency` 整数参数以覆盖默认的 Concurrency_Limit。
3. THE 现有 `/api/export` 端点 SHALL 接受可选的 `segmentDuration` 整数参数（单位：秒）以覆盖默认的片段时长。
4. WHEN 并行模式启用时, THE `/api/export` 端点 SHALL 使用并行分段下载管线替代单流方式。
5. THE `/api/progress` SSE 端点 SHALL 继续正常工作，以与现有单流管线相同的格式传递来自并行管线的进度事件。
