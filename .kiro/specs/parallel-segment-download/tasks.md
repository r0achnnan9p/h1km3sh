# Implementation Plan: Parallel Segment Download

## Overview

Implement parallel segment downloading for the Hikvision DVR video downloader. The implementation follows a modular pipeline architecture: split time range → download segments concurrently → trim overlaps → concatenate → remux to MP4. Each module lives in `lib/` and is wired together through a main pipeline orchestrator. The existing `/api/export` endpoint is extended with optional parameters to enable parallel mode.

## Tasks

- [x] 1. Set up project structure and testing infrastructure
  - [x] 1.1 Create `lib/` directory structure and install fast-check
    - Create `lib/` directory with empty module files: `segment-splitter.js`, `download-manager.js`, `segment-trimmer.js`, `concatenator.js`, `remuxer.js`, `progress-reporter.js`, `parallel-download.js`
    - Add `fast-check` as a dev dependency
    - Add test script to `package.json`: `"test": "node --test"`
    - Create `test/` directory for test files
    - _Requirements: 10.4_

- [x] 2. Implement SegmentSplitter module
  - [x] 2.1 Implement `splitTimeRange()` function in `lib/segment-splitter.js`
    - Accept parameters: `startTime`, `endTime`, `segmentDuration` (default 120, min 30), `overlapDuration` (default 3)
    - Parse Hikvision time format (`20231012T080000Z`) to Date objects
    - Split time range into equal-length segments; last segment covers remainder
    - Add `overlapDuration` seconds before each segment (except first) and after each segment (except last)
    - Return array of `TimeSegment` objects with `index`, `startTime`, `endTime`, `originalStart`, `originalEnd`, `isFirst`, `isLast`, `overlapBefore`, `overlapAfter`
    - Ensure all time boundaries are aligned to whole seconds
    - When total duration ≤ 60s, return single segment covering full range with no overlap
    - Validate `segmentDuration` ≥ 30, throw error otherwise
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6_

  - [ ]* 2.2 Write property test: Property 1 - Segment complete coverage
    - **Property 1: 片段完整覆盖**
    - Generate random time ranges (61s-86400s) and random segmentDuration (30-600s)
    - Assert that original time ranges (without overlap) fully cover input range with no gaps and no duplicates
    - Assert all segments except last have length equal to segmentDuration
    - **Validates: Requirements 1.1**

  - [ ]* 2.3 Write property test: Property 2 - Overlap extension correctness
    - **Property 2: 重叠扩展正确性**
    - Generate random time ranges + random overlapDuration (1-10s)
    - Assert non-first segments have startTime = originalStart - overlapDuration
    - Assert non-last segments have endTime = originalEnd + overlapDuration
    - **Validates: Requirements 1.2, 1.3**

  - [ ]* 2.4 Write property test: Property 3 - Whole-second alignment
    - **Property 3: 整秒对齐**
    - Generate random input parameters
    - Assert all startTime and endTime values have no sub-second precision
    - **Validates: Requirements 1.5**

  - [ ]* 2.5 Write property test: Property 4 - Short range no split
    - **Property 4: 短时间范围不分段**
    - Generate random time ranges (1-60s)
    - Assert exactly one segment returned covering full range with no overlap extension
    - **Validates: Requirements 1.4, 8.1**

- [x] 3. Implement ProgressReporter module
  - [x] 3.1 Implement `lib/progress-reporter.js`
    - Create `ProgressReporter` class that wraps the existing `broadcastProgress` mechanism
    - Accept `taskId` and SSE clients array in constructor
    - Implement `reportProgress(update)` method that formats `ProgressUpdate` into SSE-compatible messages
    - Include phase labels: "segmenting", "downloading", "trimming", "concatenating", "remuxing"
    - Show segment completion status (N/M completed) and in-progress segment indices
    - Show retry information when a segment is retrying
    - Calculate aggregate download progress: sum of received bytes / sum of estimated bytes × 85% weight
    - Add phase weights: download 85%, trim 5%, concatenate 3%, remux 7%
    - Ensure SSE event format is compatible with existing frontend `onmessage` handler (fields: `taskId`, `status`, `progress`, `message`)
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 10.5_

  - [ ]* 3.2 Write property test: Property 12 - Progress percentage calculation
    - **Property 12: 进度百分比计算**
    - Generate random byte counts per segment (received and estimated)
    - Assert calculated progress = (totalReceived / totalEstimated) × downloadWeight, clamped to 0-100
    - **Validates: Requirements 6.1**

- [x] 4. Implement DownloadManager module
  - [x] 4.1 Implement `lib/download-manager.js` with concurrent download orchestration
    - Create `downloadAll(options)` async function
    - Implement concurrency pool: maintain at most `concurrency` active ffmpeg/RTSP processes
    - Detect codec from first segment using ffprobe (H.264 or HEVC)
    - For each segment, spawn ffmpeg with: `-rtsp_transport tcp`, `-i rtspUrl`, `-c:v copy`, `-an`, `-bsf:v {bsf}`, `-f {codec}`, `-y`, output path
    - Track bytes received per segment from ffmpeg stderr output
    - When a segment completes, immediately start next queued segment
    - Store each segment as independent Annex B file in downloads directory
    - Report progress via `onProgress` callback
    - _Requirements: 2.1, 2.2, 2.5, 2.6, 2.7, 7.1, 7.2_

  - [x] 4.2 Implement retry logic and failure handling
    - On segment download failure, retry up to 2 times (max 3 total attempts)
    - After all retries exhausted for a segment, abort all remaining downloads (kill active ffmpeg processes)
    - Track retry count per segment and report via progress callback
    - _Requirements: 2.3, 2.4_

  - [x] 4.3 Implement connection-refused adaptive degradation
    - Detect RTSP connection refused errors from ffmpeg stderr
    - On connection refused: decrement current task's concurrency limit by 1, retry the refused segment
    - If concurrency drops to 0: trigger fallback to sequential single-stream mode
    - Notify progress reporter of concurrency changes
    - _Requirements: 7.3, 7.4, 8.2_

  - [x] 4.4 Implement cleanup on failure and cancellation
    - Track all intermediate files created during export
    - On failure after retries exhausted: delete all intermediate segment files
    - On cancellation: send SIGTERM to all active ffmpeg processes, wait up to 5s, then SIGKILL if needed, delete all intermediate files
    - Never delete a successfully created final MP4 file
    - _Requirements: 9.1, 9.2, 9.3_

  - [ ]* 4.5 Write property test: Property 5 - Concurrency never exceeds limit
    - **Property 5: 并发不超限**
    - Mock ffmpeg spawning with random download durations
    - Generate random segment counts (1-20) and concurrency limits (1-8)
    - Assert active connection count never exceeds concurrency limit at any point
    - **Validates: Requirements 2.1, 7.1**

  - [ ]* 4.6 Write property test: Property 6 - Retry limit respected
    - **Property 6: 失败重试上限**
    - Mock random failure patterns
    - Assert each failed segment is retried at most 2 times (3 total attempts max)
    - **Validates: Requirements 2.3**

  - [ ]* 4.7 Write property test: Property 7 - Abort after retries exhausted
    - **Property 7: 重试耗尽后中止**
    - Mock persistent failure for a segment
    - Assert all remaining queued/in-progress downloads are aborted
    - **Validates: Requirements 2.4**

  - [ ]* 4.8 Write property test: Property 13 - Adaptive degradation on connection refused
    - **Property 13: 连接拒绝时自适应降级**
    - Mock random connection-refused patterns
    - Assert concurrency decrements by 1 on each refusal and segment is retried
    - **Validates: Requirements 7.4**

  - [ ]* 4.9 Write property test: Property 14 - Fallback to sequential on all refused
    - **Property 14: 全部拒绝回退顺序模式**
    - Mock all connections being refused
    - Assert system falls back to single-stream sequential download
    - **Validates: Requirements 8.2**

  - [ ]* 4.10 Write property test: Property 15 - Cleanup intermediate files on failure/cancel
    - **Property 15: 失败或取消时清理中间文件**
    - Mock failures at random pipeline stages
    - Assert all intermediate files are deleted but final MP4 (if exists) is preserved
    - **Validates: Requirements 9.1, 9.2, 9.3**

- [x] 5. Checkpoint - Core download logic
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Implement SegmentTrimmer module
  - [x] 6.1 Implement `lib/segment-trimmer.js`
    - Create `trimOverlaps(segments, segmentFiles, codec, overlapDuration)` async function
    - For the first segment: no trimming needed, return as-is
    - For subsequent segments: calculate byte offset corresponding to `overlapDuration` seconds
    - Parse Annex B stream to locate NAL unit start codes (`0x00 0x00 0x00 0x01`)
    - Identify I-frame NAL types: H.264 type 5 (IDR), HEVC type 19/20 (IDR_W_RADL / IDR_N_LP)
    - Find first I-frame at or after the overlap duration timestamp
    - If no I-frame found within 2 seconds after expected trim point: fall back to nearest byte boundary at overlap duration
    - Write trimmed output to `*_trimmed.h264` file, preserving Annex B format
    - _Requirements: 3.1, 3.2, 3.3, 3.4_

  - [ ]* 6.2 Write property test: Property 8 - Trim starts at I-frame
    - **Property 8: 裁剪从 I 帧开始**
    - Generate synthetic Annex B streams with random I-frame positions
    - Assert trimmed output starts from I-frame at or after overlap duration (within 2s window)
    - **Validates: Requirements 3.1, 3.2**

  - [ ]* 6.3 Write property test: Property 9 - Trim preserves Annex B format
    - **Property 9: 裁剪保持格式**
    - Generate synthetic Annex B streams
    - Assert trimmed output starts with valid start code and contains valid NAL unit structure
    - **Validates: Requirements 3.4**

- [x] 7. Implement Concatenator module
  - [x] 7.1 Implement `lib/concatenator.js`
    - Create `concatenate(trimmedFiles, outputPath)` async function
    - Validate all input files exist and have non-zero size; report error with missing segment indices if validation fails
    - Perform binary concatenation in index order using streaming reads/writes
    - Output single Annex B file at `outputPath`
    - Delete individual segment files after successful concatenation
    - _Requirements: 4.1, 4.2, 4.3, 4.4_

  - [ ]* 7.2 Write property test: Property 10 - Concatenation order correct
    - **Property 10: 拼接顺序正确**
    - Generate random binary Buffer arrays
    - Assert concatenated output equals sequential Buffer.concat of inputs in index order
    - **Validates: Requirements 4.1**

  - [ ]* 7.3 Write property test: Property 11 - Missing segment detection
    - **Property 11: 缺失片段检测**
    - Generate file sets with random missing/zero-byte entries
    - Assert error is thrown identifying all missing segment indices
    - **Validates: Requirements 4.4**

- [x] 8. Implement Remuxer module
  - [x] 8.1 Implement `lib/remuxer.js`
    - Create `remux(options)` async function accepting `inputPath`, `outputPath`, `frameRate` (default 20), `faststart` (default true)
    - Spawn ffmpeg with: `-r {frameRate}`, `-i inputPath`, `-c copy`, `-movflags +faststart`, `-y`, `outputPath`
    - Delete intermediate concatenated Annex B file after successful remux
    - Report completion status and output filename via progress callback
    - _Requirements: 5.1, 5.2, 5.3, 5.4_

- [x] 9. Implement parallel download pipeline orchestrator
  - [x] 9.1 Implement `lib/parallel-download.js` main pipeline entry point
    - Create `runParallelDownload(params)` async function that orchestrates the full pipeline
    - Accept parameters: `ip`, `user`, `pass`, `channel`, `startTime`, `endTime`, `concurrency`, `segmentDuration`, `taskId`, `sseClients`
    - Pipeline steps: split → detect codec → download all → trim overlaps → concatenate → remux
    - Instantiate ProgressReporter and wire progress callbacks through all stages
    - Handle fallback to sequential mode when parallel is not feasible (duration ≤ 60s or all connections refused)
    - Implement cancellation support via task status check
    - Return final MP4 file path on success
    - _Requirements: 10.4, 8.1, 8.2, 8.3_

- [x] 10. Extend `/api/export` endpoint with parallel download support
  - [x] 10.1 Modify `server.js` to integrate parallel download pipeline
    - Add optional `parallel` boolean parameter (default: `true`) to request body parsing
    - Add optional `concurrency` integer parameter (default: 4, range 1-8) to request body parsing
    - Add optional `segmentDuration` integer parameter (default: 120, min 30) to request body parsing
    - When `parallel=true` and duration > 60s: invoke `runParallelDownload()` from `lib/parallel-download.js`
    - When `parallel=false` or duration ≤ 60s: use existing single-stream download logic
    - Ensure SSE progress events from parallel pipeline use same format as existing single-stream events
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5_

  - [ ]* 10.2 Write unit tests for API parameter parsing and routing
    - Test that `parallel`, `concurrency`, `segmentDuration` are correctly parsed with defaults
    - Test routing logic: parallel=true + duration>60s → parallel pipeline, otherwise → single-stream
    - Test parameter validation (concurrency range, segmentDuration minimum)
    - _Requirements: 10.1, 10.2, 10.3_

- [x] 11. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- The project uses JavaScript (ESM modules) with Node.js built-in test runner and fast-check for property-based testing
- All modules use the existing patterns from `server.js` (ES module imports, ffmpeg-static/ffprobe-static paths)
