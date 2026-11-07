// Run only against the disposable PostgreSQL cluster created by the verification script.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import pg from 'pg'
import { createHubSyncStatusRepository } from '../apps/api-server/src/repositories/hub-sync-status-repository.js'

const pool = new pg.Pool({ connectionString: process.env.CHAIN_TEST_POSTGRES_URL })
try {
  await pool.query('create schema content_platform; create table content_platform.content_jobs(id text primary key);')
  const sql = await readFile(new URL('../infra/sql/010_hub_sync_status.sql', import.meta.url), 'utf8')
  await pool.query(sql)
  await pool.query(sql)
  await pool.query("insert into content_platform.content_jobs(id) values('test-job')")
  const first = createHubSyncStatusRepository(pool)
  const second = createHubSyncStatusRepository(pool)
  const attempts = await Promise.all([first.begin('test-job'), second.begin('test-job')])
  assert.equal(attempts.filter(Boolean).length, 1)
  await first.finish('test-job', attempts.find(Boolean), { status: 'failed', message: '同步失败', received: 1, succeeded: 0, failed: 1 })
  assert.equal((await second.get('test-job')).status, 'failed')
  const retry = await second.begin('test-job')
  assert.ok(retry)
  await second.finish('test-job', retry, { status: 'success', message: '已同步', received: 1, succeeded: 1, failed: 0 })
  assert.equal((await createHubSyncStatusRepository(pool).get('test-job')).status, 'success')
  console.log('PASS PostgreSQL：迁移可重复执行、并发互斥、状态持久化及重试')
} finally {
  await pool.end()
}
