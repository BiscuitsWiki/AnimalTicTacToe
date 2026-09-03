/**
 * 网络地址集中配置。
 *
 * - H5 生产：与页面同源——API 走相对路径，WS 按页面协议自动选 ws/wss，
 *   由部署侧 nginx 反代（client/nginx.conf）转发到 server，HTTPS 下无混合内容问题
 * - H5 开发：dev server(10086) 与后端(3000) 跨端口，直连 hostname:3000
 * - 小程序（weapp）：模拟器/真机的 localhost 指向手机自身，必须走电脑的局域网 IP
 *
 * ★ 小程序真机联调前：
 *   1. 手机与电脑连接同一 WiFi
 *   2. 查询电脑局域网 IP（PowerShell: Get-NetIPAddress -AddressFamily IPv4）
 *   3. 更新下方 LAN_IP 后重新 build:weapp
 *   4. Windows 防火墙放行 3000 端口（首次启动 Node 时会弹窗）
 */

/** 电脑的局域网 IP（IP 变化时改这里） */
const LAN_IP = '10.48.27.83'
const DEV_PORT = 3000

function resolveBase(): { api: string; ws: string } {
  // 小程序：直连电脑局域网 IP
  if (process.env.TARO_ENV === 'weapp') {
    return { api: `http://${LAN_IP}:${DEV_PORT}`, ws: `ws://${LAN_IP}:${DEV_PORT}/ws` }
  }

  // 非 H5 环境（SSR/测试）兜底
  if (typeof location === 'undefined') {
    return { api: `http://localhost:${DEV_PORT}`, ws: `ws://localhost:${DEV_PORT}/ws` }
  }

  // H5 开发：页面在 dev server 端口，后端固定 3000，跨端口直连
  if (process.env.NODE_ENV === 'development') {
    return {
      api: `http://${location.hostname}:${DEV_PORT}`,
      ws: `ws://${location.hostname}:${DEV_PORT}/ws`,
    }
  }

  // H5 生产：同源相对地址（nginx 反代），自动适配 http/https
  const wsScheme = location.protocol === 'https:' ? 'wss' : 'ws'
  return { api: '', ws: `${wsScheme}://${location.host}/ws` }
}

const base = resolveBase()

/** API 基址（生产为 ''，即同源相对路径） */
export const API_BASE = base.api
/** WebSocket 地址 */
export const WS_BASE = base.ws
