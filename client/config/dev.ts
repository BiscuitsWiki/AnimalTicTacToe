import type { UserConfigExport } from "@tarojs/cli"

export default {
   logger: {
    quiet: false,
    stats: true
  },
  mini: {},
  h5: {
    devServer: {
      // 绑定 0.0.0.0：局域网设备（手机/其他电脑）可通过 http://<电脑IP>:10086 访问
      host: '0.0.0.0',
      // 允许来自局域网 IP 的页面访问 dev server
      allowedHosts: 'all'
    }
  }
} satisfies UserConfigExport<'webpack5'>
