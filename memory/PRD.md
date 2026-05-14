# PRD · 点球大战金库 (Penalty Shootout Vault) + 网页托管平台

## 原始问题陈述
用户希望写一套 FLAP 兼容的金库合约，蹭世界杯热度，核心玩法：**5 分钟无人购买（无人进球），最后购买者（进球者）获得金库 80% 奖金，剩余 20% 滚入下一轮**。后扩展为：网页托管平台让用户无需本地脚本即可托管运行。

## 用户选择（已确认）
- 网页托管版 ✅ / keeperFeeBps 0.5% ✅ / 公开战况展示 ✅
- 无加时赛 / 无种子奖池 / buyAndShoot 一键 ✅
- BSC 测试网先试 ✅ / 默认参数（5min/0.001/80:20）✅
- 世界杯红绿足球场配色 ✅

## 核心架构

### Phase 1 · 智能合约（✅ 完成）
- Foundry 项目 `/app/contracts/`
- `PenaltyShootoutVault.sol` — V2.1 金库（含 vaultUISchema）
- `PenaltyShootoutVaultFactory.sol` — 工厂（vaultDataSchema + policy + 钩子）
- **21 单元测试全部通过**
- 解决买家识别难题：**"shoot 主动宣告 + dispatch 验证"** 模式

### Phase 2 · 网页托管平台（✅ 完成）
- 后端 `/app/backend/server.py`（FastAPI + Web3.py + Motor）
- 前端 `/app/frontend/src/`（React + Tailwind，世界杯红绿主题）
- 路由：`/` 公开仪表盘 ｜ `/admin` 管理后台
- Bot Manager：7×24 监听 BSC Transfer 事件 + 自动 shoot + 自动 settleRound
- JWT 鉴权 + Fernet 加密私钥
- WebSocket 实时推送

## 已实现功能矩阵

| 模块 | 功能 | 状态 |
|------|------|------|
| Vault | shoot / buyAndShoot / settleRound / claim | ✅ |
| Vault | description / vaultUISchema (V2.1) | ✅ |
| Vault | keeper 激励 / pull-pattern / Guardian 紧急权限 | ✅ |
| Factory | newVault / vaultDataSchema / policy / 校验钩子 | ✅ |
| Backend | Admin 登录 (JWT 24h) | ✅ |
| Backend | 配置 CRUD (chain/rpc/vault/token/poll) | ✅ |
| Backend | Keeper 私钥导入/生成（AES 加密存储） | ✅ |
| Backend | Bot 启停 / 状态 / 日志 (500 条 LRU) | ✅ |
| Backend | 公开 API: state/rounds/shots/config-public | ✅ |
| Backend | WebSocket /api/ws 实时推送 | ✅ |
| Backend | 自动 settleRound | ✅ |
| Frontend | 公开仪表盘（巨型倒计时/奖池/Feed/榜单） | ✅ |
| Frontend | Admin 后台（4 区块布局 + 实时日志） | ✅ |
| Frontend | RPC UNREACHABLE / SETUP REQUIRED 横幅 | ✅ |
| Frontend | 玩法规则中英双语切换 | ✅ |
| Frontend | BscScan 地址/交易跳转 | ✅ |

## 测试结果
- 智能合约：21/21 Foundry 单元测试通过
- 后端 API：19/19 pytest 通过
- 前端：所有公开 + admin 流程通过 Playwright 验证

## 测试凭证
见 `/app/memory/test_credentials.md`
- Admin: `admin` / `shootout2026`

## 部署信息
- Solc 0.8.20 + via-IR ✅
- 工厂未部署到链上（待用户决定 testnet/mainnet）
- 网页平台运行于 Emergent preview env

## 已实现日期
| 日期 | 内容 |
|------|------|
| 2026-01 | Phase 1 合约 + Foundry 测试 |
| 2026-01 | Phase 2 后端 FastAPI + Bot Manager |
| 2026-01 | Phase 2 前端 React 仪表盘 + Admin |
| 2026-01 | RPC UNREACHABLE banner / 0x prefix 一致性修复 |

## 待办（P1+）
- [ ] 用户钱包连接（MetaMask）+ 前端直接调 `buyAndShoot()`
- [ ] 历史轮次详情页（每轮逐脚射门时间线回放）
- [ ] Discord/Telegram 集成（自动播报冠军）
- [ ] Twitter 战绩分享卡片生成器
- [ ] 多金库支持（一个网站托管多个游戏）
- [ ] 异常告警（Keeper 余额 < 0.01 BNB / RPC 断连超 N 次）

## 下一步行动（建议）
1. 部署 Factory 到 BSC 测试网（用户操作）
2. 在 Flap.sh 测试网发币 + 选自定义 Factory
3. 在 Admin 配置 vault/token/keeper → 启动 Bot
4. 测试网跑通 ≥ 5 轮 → 上主网
