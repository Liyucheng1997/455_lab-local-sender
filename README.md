# 网页快传（网页版 LocalSend）

同一个网络下的设备打开这个网页，就能自动互相看到，把文件拖到对方设备上就能发送。不用安装软件，也不用登录微信。

**在线使用：<https://file.liyucheng.me>**

- **自动发现**：服务器按出口公网 IP 把设备分组，同一个 Wi-Fi 或路由器下的设备会出现在彼此的列表里
- **点对点直连**：文件走浏览器之间的 WebRTC 直连，不经过服务器，也不会存到服务器上，局域网内速度很快
- **自动兜底**：直连失败时自动改由服务器 WebSocket 中转，卡片上会显示“经服务器中转”
- **断线续传**：服务器连接抖动、手机切到别的 App、换 Wi-Fi/流量，90 秒内回来都算同一台设备，传到一半的文件从断点接着传；直连中途断了自动改走中转续传
- **配对码**：不在同一出口网络时（比如一台用手机流量），两边输入同一个配对码也能互相看到
- **拖拽发送**：把文件、文件夹、选中的文字或链接拖进页面，设备卡片会浮起来，拖到哪台就发给哪台；只有一台对方设备时松在任意位置都行。也可以点设备选文件，或按 Ctrl+V 粘贴
- **发文件夹**：拖入文件夹，或点设备上的“文件夹”按钮（电脑浏览器）选择。对方收完后自动打包成一个 ZIP 下载，保留目录结构；一次最多 5000 个文件
- **发文字**：发链接、发一段话，对方点“复制”即可
- **接收确认**：默认先询问，可以勾选“以后自动接收这台设备的文件”或“自动接收文件”
- 深色模式，手机浏览器也能用

## 本地运行

```bash
npm install
npm start
```

浏览器打开 `http://localhost:3000`，同一局域网的其他设备打开启动日志里显示的 `http://192.168.x.x:3000`。

> 服务器在局域网内运行时，所有内网地址都归为同一组。

## 部署到公网（推荐，部署后两台电脑直接打开网址就能用）

服务器只负责“介绍设备认识”和转发信令，流量很小。随便一台能跑 Node.js 18+ 的服务器都行，必须支持 WebSocket。

**方式一：云服务器 / VPS（国内访问最稳定）**

```bash
git clone <本仓库> && cd <目录>
npm install --omit=dev
PORT=3000 node server.js   # 建议用 pm2 守护：pm2 start server.js --name web-localsend
```

前面用 Nginx 反向代理时要转发 WebSocket 头，并传真实 IP：

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 3600s;
}
```

**方式二：Docker**

```bash
docker build -t web-localsend .
docker run -d -p 3000:3000 --name web-localsend web-localsend
```

**方式三：Render（免费，海外）**：在 Render 新建 Blueprint，选这个仓库即可（已附 `render.yaml`）。免费实例空闲 15 分钟后会休眠，再次打开要等几十秒；国内访问可能较慢。

> 部署在公网时一定要让服务器拿到用户的真实 IP（直连，或代理设置 `X-Real-IP` / `X-Forwarded-For`）。否则所有人看起来都来自同一个地址，会被分到一组。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `RELAY` | 开启 | 设为 `0` 关闭服务器中转（只允许直连，省服务器带宽） |
| `GRACE_MS` | `90000` | 设备掉线后保留身份的毫秒数，期间重连可续传 |
| `ICE_SERVERS` | 小米 / B 站 / Cloudflare / Google STUN | JSON 数组，可加入自己的 TURN，例如 `[{"urls":"turn:example.com:3478","username":"u","credential":"p"}]` |

## 常见问题

- **两台电脑在同一个 Wi-Fi 下却看不到对方**：运营商可能给一台分配了 IPv6、另一台走 IPv4，出口地址就不同了。用右上角的**配对码**，或者给域名只配 A 记录（IPv4）。
- **一直显示“经服务器中转”**：浏览器之间没打通直连（比如路由器开了 AP 隔离、公司网络限制）。照样能传，只是速度受服务器带宽限制。鼠标停在这行字上能看到原因；跨运营商、跨国，或一方用手机流量时很常见（对称型 NAT 打不了洞），页面会在后台定期重试直连。服务器日志（`journalctl -u app-localsender`）里的 `diag` 行记录了每次直连的结果。
- **大文件**：接收方会先把文件存在浏览器里，传完再保存。几个 GB 的文件 Chrome、Edge 一般没问题，手机浏览器上内存可能不够。
- **安全**：只有同一出口 IP（或同一配对码）的设备能互相看到，收文件前默认要确认。在公司、学校这类很多人共用出口 IP 的网络里，同一网络的其他人也能看到你的设备名，建议不要勾选“自动接收文件”。

## 文件结构

```
server.js         信令服务器 + 静态文件 + 中转
public/index.html 页面
public/app.js     发现、WebRTC 传输、中转兜底、界面逻辑
public/style.css  页面样式（基于 tokens.css 设计变量）
```
