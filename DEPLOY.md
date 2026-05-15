# ⚽ Penalty Shootout Vault — 部署完整指南（小白版）

> 你需要分两步：①后端 Keeper Bot 部署到 Railway → ②前端部署到 Cloudflare Pages

---

## 🎯 第一部分：后端 Keeper Bot → Railway（约 10 分钟）

### Step 1：准备 MongoDB（免费）

1. 打开 [mongodb.com/cloud/atlas/register](https://www.mongodb.com/cloud/atlas/register) 注册账号
2. 创建 **Free Tier** (M0 Cluster)，选 AWS / Singapore / Tokyo 等近你的区域
3. **Database Access** → 创建一个用户（记下用户名/密码）
4. **Network Access** → Add IP Address → **Allow Access from Anywhere** (`0.0.0.0/0`)
5. **Database** → Connect → **Drivers** → 复制连接串（形如 `mongodb+srv://USER:PASS@cluster0.xxxxx.mongodb.net/...`）
6. **把 `<password>` 替换成你真实密码**

### Step 2：注册 Railway

1. 打开 [railway.app](https://railway.app) → 用 GitHub 账号登录
2. **New Project** → **Deploy from GitHub Repo**（如果你还没 push 到 GitHub，先用本仓库根目录运行 `git init && git add . && git commit -m "init"` 然后 push 到 GitHub）
   - 或：**Deploy → Empty Project** → 再用 Railway CLI 上传

### Step 3：让 Railway 只构建 backend 子目录

在 Railway 项目设置：
1. **Settings** → **Source** → **Root Directory** 填 `backend`
2. **Settings** → **Build** → Builder = **Dockerfile**（railway.toml 已配好）
3. **Settings** → **Networking** → **Generate Domain**（生成 `xxx.up.railway.app` 域名）

### Step 4：配置环境变量

进入 Railway 项目 → **Variables** → **Raw Editor** 粘贴下面内容（替换 `XXX`）：

```
MONGO_URL=mongodb+srv://USER:PASS@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
DB_NAME=penalty_shootout_vault
CORS_ORIGINS=https://YOUR_PROJECT.pages.dev
JWT_SECRET=XXX_用_openssl_rand_hex_32_生成
ENCRYPTION_SEED=XXX_用_openssl_rand_hex_32_生成
ADMIN_USERNAME=admin
ADMIN_PASSWORD=你的强密码
```

> 💡 在本地终端运行 `openssl rand -hex 32` 各生成一遍填入

### Step 5：触发部署

保存环境变量后 Railway 会自动重新部署。Logs 看到 `Application startup complete` 即成功。

记下后端域名（如 `penalty-shootout.up.railway.app`），下面前端要用。

### Step 6：测试后端

```bash
curl https://your-backend.up.railway.app/api/health
# 应返回 {"status":"ok","ts":...}
```

---

## 🌐 第二部分：前端 → Cloudflare Pages（约 5 分钟）

### Step 1：本地准备

需要装 Node.js 18+ 和 yarn（[nodejs.org](https://nodejs.org) 下载 LTS）：

```bash
# 解压源码后进入 frontend 目录
cd frontend
yarn install
```

### Step 2：修改后端地址

编辑 `frontend/.env`，把 `REACT_APP_BACKEND_URL` 改成你的 Railway 后端：

```
REACT_APP_BACKEND_URL=https://penalty-shootout.up.railway.app
```

### Step 3：构建生产包

```bash
yarn build
```

完成后会得到 `frontend/build/` 文件夹。

### Step 4：上传 Cloudflare Pages

1. 打开 [dash.cloudflare.com](https://dash.cloudflare.com)（免费注册）
2. 左侧 **Workers & Pages** → **Create application** → **Pages** → **Upload assets**
3. 项目名（如 `penalty-shootout`）→ **Create project**
4. 把 `frontend/build/` 整个文件夹拖进上传区
5. **Deploy site** → 完成后获得 `penalty-shootout.pages.dev`

### Step 5：回到 Railway 更新 CORS

回到 Railway → Variables → 改 `CORS_ORIGINS` 为：

```
CORS_ORIGINS=https://penalty-shootout.pages.dev
```

Railway 会自动重启。

### Step 6：访问网站 ✅

打开 `https://penalty-shootout.pages.dev`，应该能看到完整的点球大战 Dashboard，**无水印**。

---

## 🆘 常见问题

### Q1: 前端连不上后端 / CORS 错误
- 检查 Railway 的 `CORS_ORIGINS` 是否包含你的 Cloudflare 域名（多个用逗号分隔）
- 检查浏览器 Network 标签，确认请求 URL 是你 Railway 域名
- 临时调试：把 `CORS_ORIGINS` 设为 `*` 重启

### Q2: WebSocket 不工作
- Railway 默认支持 ws://wss://，无需额外配置
- 确认 `REACT_APP_BACKEND_URL` 是 `https://`（前端会自动转换为 `wss://`）

### Q3: 后端反复重启
- Railway Logs 看错误，最常见原因：MongoDB 连接失败（检查 Atlas Network Access 是否开了 `0.0.0.0/0`）

### Q4: 想自定义域名
- Cloudflare Pages：Settings → Custom Domains → 添加你的域名（自动配 SSL）
- Railway：Settings → Networking → Custom Domain → 添加（自动配 SSL）

### Q5: Railway 免费额度耗尽？
- Railway 每月 $5 免费额度（够小项目）
- 替代方案：Render.com（免费 750h/月，但休眠后冷启动 30 秒）；Fly.io（免费 3 个小机器）

---

## 📊 部署后的运维

### 启动 Bot
1. 访问 `https://penalty-shootout.pages.dev/admin`
2. 用你设置的 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 登录
3. 配置 RPC URL / Vault Address / Tax Token Address
4. 上传 Keeper 钱包私钥（或点"自动生成新钱包"）
5. 给 Keeper 钱包充值 0.1~0.3 BNB 作为 gas
6. 点 **▶ Start** 启动 Bot

### 监控
- Railway → Observability → 查看 CPU/内存/请求量
- Admin 后台 → Bot 日志（实时刷新）

---

## 🔒 安全 Checklist

- [ ] `JWT_SECRET` 已用 `openssl rand -hex 32` 生成
- [ ] `ENCRYPTION_SEED` 已用 `openssl rand -hex 32` 生成
- [ ] `ADMIN_PASSWORD` 已改为强密码
- [ ] `CORS_ORIGINS` 已精确填到 Pages 域名，不要永久 `*`
- [ ] MongoDB Atlas Network Access 长期建议加白名单（Railway 出口 IP 可在文档查）
- [ ] Keeper 钱包只放够 gas 的 BNB（推荐 0.1~0.3），不要充大额

---

部署遇到问题？随时回到本聊天问我，我帮你 debug 🚀
