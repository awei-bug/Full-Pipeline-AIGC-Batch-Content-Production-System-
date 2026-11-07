import crypto from "node:crypto";

// A five-minute lease prevents overlapping writes for a job and allows recovery
// after a crashed process. The hub HTTP timeout is much shorter than the lease.
const LEASE_MS = 300_000;

function displayState(state) {
  if (state?.status === "syncing" && Date.now() - Date.parse(state.updatedAt) >= LEASE_MS) {
    return { ...state, status: "unknown", message: "上次同步中断，请重试" };
  }
  return state;
}

export function createHubSyncStatusRepository(pool) {
  const memory = new Map();
  return {
    async get(jobId) {
      if (!pool) return displayState(memory.get(jobId) || null);
      const result = await pool.query("select status, message, received, succeeded, failed, updated_at from content_platform.hub_sync_status where job_id=$1", [jobId]);
      const row = result.rows[0];
      return row ? displayState({ ...row, updatedAt: row.updated_at, updated_at: undefined }) : null;
    },
    async begin(jobId) {
      const attemptId = crypto.randomUUID();
      if (!pool) {
        const old = memory.get(jobId);
        if (old?.status === "syncing" && Date.now() - Date.parse(old.updatedAt) < LEASE_MS) return null;
        memory.set(jobId, { attemptId, status: "syncing", message: "正在同步", received: 0, succeeded: 0, failed: 0, updatedAt: new Date().toISOString() });
        return attemptId;
      }
      const result = await pool.query(`insert into content_platform.hub_sync_status(job_id,attempt_id,status,message)
        values($1,$2,'syncing','正在同步') on conflict(job_id) do update set
        attempt_id=excluded.attempt_id,status='syncing',message='正在同步',received=0,succeeded=0,failed=0,updated_at=now()
        where content_platform.hub_sync_status.status <> 'syncing' or content_platform.hub_sync_status.updated_at < now() - interval '5 minutes'
        returning attempt_id`, [jobId, attemptId]);
      return result.rowCount ? attemptId : null;
    },
    async finish(jobId, attemptId, state) {
      if (!pool) {
        if (memory.get(jobId)?.attemptId !== attemptId) return;
        memory.set(jobId, { ...state, attemptId, updatedAt: new Date().toISOString() });
        return;
      }
      await pool.query(`update content_platform.hub_sync_status set status=$3,message=$4,received=$5,succeeded=$6,failed=$7,updated_at=now()
        where job_id=$1 and attempt_id=$2`, [jobId, attemptId, state.status, state.message, state.received, state.succeeded, state.failed]);
    },
  };
}
