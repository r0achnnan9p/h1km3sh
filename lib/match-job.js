/** 指定哪些镜头就导出哪些；多个镜头共享一个任务，依次处理 DVR 会话。 */
import fs from 'node:fs';
import path from 'node:path';
import { prepareCameraJob } from './camera-jobs.js';
import { allocateArtifact, artifactWorkDir, cleanArtifactWork } from './artifacts.js';
import { createOutputAlias } from './output-library.js';

export function prepareMatchJob(args, dependencies, restoredJobs) {
  if (!Array.isArray(args?.cameras) || args.cameras.length < 1 || args.cameras.length > 8 || args.cameras.some(c => typeof c !== 'string')) throw new Error('cameras 必须包含 1–8 个指定镜头。');
  const ids = args.cameras.map(alias => dependencies.resolveCamera(alias).camera.id);
  if (new Set(ids).size !== ids.length) throw new Error('不能重复指定同一镜头。');
  const jobs = restoredJobs || args.cameras.map(camera => prepareCameraJob('clip', { camera, start: args.start, end: args.end, matchup: args.matchup, mode: args.mode, dvrMethod: args.dvrMethod }, dependencies));
  if (new Set(jobs.map(j => j.filename)).size !== jobs.length) throw new Error('不能重复指定同一镜头。');
  return {
    kind: 'batch', recoveryRequest: { type: 'batch', args: { cameras: ids }, jobs: jobs.map(job => job.recoveryRequest) }, filenames: jobs.map(j => j.filename),
    requests: jobs.map(({ filename, cameraId, start, end, mode, sourceIdentity }) => ({ filename, camera: cameraId, start, end, mode, sourceIdentity })),
    requestKey: JSON.stringify({ sources: jobs.map(j => [j.cameraId, j.sourceIdentity]).sort(), files: jobs.map(j => j.filename).sort(), start: jobs[0].start, end: jobs[0].end, mode: jobs[0].mode, dvrMethod: args.dvrMethod || 'auto' }),
    async execute({ signal, reservation, onFile, onProgress, onPlan, publishResult, reusedFiles = new Map() }) {
      const files = [];
      const planned = [];
      for (const job of jobs) {
        const reused = reusedFiles.get(job.filename);
        if (reused) {
          files.push(reused);
          onFile?.(reused, files.length, jobs.length);
        } else { const plan = await job.plan({ signal }); onPlan?.(plan, job.filename); planned.push({ job, plan }); }
      }
      // 先交付已在本地的镜头，较慢的 DVR 下载不会阻止这些成品出现。
      planned.sort((a, b) => Number(b.plan.source === 'mediamtx') - Number(a.plan.source === 'mediamtx'));
      for (const { job, plan } of planned) {
        if (signal.aborted) throw new Error('任务已取消。');
        const artifact = allocateArtifact('clip'), work = artifactWorkDir();
        const named = path.join(dependencies.downloadsDir, job.filename);
        let artifactPublished = false, namedPublished = false;
        try {
          const outputFile = path.join(work, path.basename(artifact.file));
          const metadata = await job.execute({ signal, reservation, outputFile, plan, onProgress });
          if (signal.aborted) throw new Error('任务已取消。');
          if (publishResult) {
            const file = await publishResult({ key: job.filename, artifact, outputFile, filename: job.filename, selected: metadata });
            files.push(file); onFile?.(file, files.length, jobs.length);
            continue;
          }
          fs.renameSync(outputFile, artifact.file);
          artifactPublished = true;
          try { fs.linkSync(artifact.file, named); }
          catch (error) {
            if (error.code !== 'EXDEV') throw error;
            onProgress?.(null, '正在保存最终文件…', null, { stage: 'finalizing', stagePercent: null });
            // 跨文件系统复制大成品时也必须保持 HTTP / 取消请求可响应。
            await fs.promises.copyFile(artifact.file, named, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
          }
          namedPublished = true;
          if (signal.aborted) throw new Error('任务已取消。');
          const outputAlias = createOutputAlias(dependencies.downloadsDir, metadata.sourceOutput, job.filename);
          delete metadata.sourceOutput;
          const file = { ...metadata, filename: job.filename, artifactUrl: artifact.url, size: fs.statSync(named).size,
            ...(outputAlias ? { outputAlias } : {}) };
          files.push(file); onFile?.(file, files.length, jobs.length);
        } catch (error) {
          // 复制结束后取消，只回滚本任务成功创建的文件；EXCL 冲突绝不删除旧成品。
          if (signal.aborted) {
            if (namedPublished) await fs.promises.unlink(named).catch(() => {});
            if (artifactPublished) await fs.promises.unlink(artifact.file).catch(() => {});
          }
          throw error;
        } finally { cleanArtifactWork(work); }
      }
      return { files, kind: 'batch' };
    },
  };
}
