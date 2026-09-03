/**
 * 进程内固定窗口限流器（零依赖，单实例部署够用；多实例需换 Redis）。
 * key 维度由调用方决定（一般是 `${接口}:${IP}`）。
 */
interface Bucket {
  count: number
  resetAt: number
}

const buckets = new Map<string, Bucket>()
/** 桶数量上限（防 key 爆炸） */
const MAX_BUCKETS = 10_000

/**
 * 命中限流返回 false（应拒绝请求），放行返回 true。
 * @param key     限流键（如 `auth:guest:1.2.3.4`）
 * @param limit   窗口内允许的最大次数
 * @param windowMs 窗口时长（毫秒）
 */
export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now()
  const bucket = buckets.get(key)
  if (!bucket || now >= bucket.resetAt) {
    // 惰性清理：桶满时顺手扫描过期项
    if (buckets.size >= MAX_BUCKETS) {
      for (const [k, v] of buckets) {
        if (now >= v.resetAt) buckets.delete(k)
      }
    }
    buckets.set(key, { count: 1, resetAt: now + windowMs })
    return true
  }
  bucket.count++
  return bucket.count <= limit
}

/** 测试辅助：清空全部桶 */
export function resetRateBuckets(): void {
  buckets.clear()
}
