import fs from 'node:fs';
import path from 'node:path';
const activeUploadStatuses = new Set(['queued', 'pending', 'uploading', 'stopping', 'reconciling']);
// Count the complete queue on disk, independently of recent-history page limits.
export function countActiveUploadJobs(directory) {
  if (!fs.existsSync(directory)) return 0;
  return fs.readdirSync(directory).filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).reduce((count, name) => {
    try { const job = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')); return count + Number(!job.archivedAt && activeUploadStatuses.has(job.status)); }
    catch { return count; }
  }, 0);
}
