# PRD · 点球大战金库 (Penalty Shootout Vault) + 网页托管平台

## 原始问题陈述

用户希望写一套 FLAP 兼容的金库合约（[规范](https://docs.flap.sh/flap/developers/vault-developers/vault-and-vaultfactory-specification)），蹭世界杯热度，核心玩法：**5 分钟无人购买（无人进球），最后购买者（进球者）获得金库 80% 奖金，剩余 20% 滚入下一轮**。

## 核心需求

### 玩法
- "点球大战" FOMO 游戏，5 分钟倒计时
- 最后射门者赢 80% 奖池，20% 滚入下一轮
- 用户主要通过 FLAP 内盘 + 交易 Bot 进行购买

### 关键技术挑战
- FLAP 税收通过 TaxProcessor 批量 dispatch，receive() 不传买家信息
- Bot 用户共用钱包，`tx.origin` 不可靠
- 已采用 **"shoot 主动宣告射门"** 模式解决：
  - 调用者显式传入 `player` 地址
  - 必须 dispatch 实际有 BNB 入账才算有效射门
  - 100% 准确识别玩家

### 配套设施
- 7×24 网页托管 Bot（自动监听 + 自动 shoot）
- 公开战况仪表盘（蹭世界杯热度引流）
- Keeper 钱包私钥加密存储

## 用户画像

| 角色 | 目标 |
|------|------|
| **代币创建者**（您） | 部署金库工厂，发币时绑定，运行 Bot 自动化 |
| **散户玩家** | 在 Flap.sh 买代币，看仪表盘，争夺最后一击 |
| **Bot 玩家** | 在交易脚本里多调一次 `shoot()` 参与游戏 |
| **Keeper 第三方** | 跑监听脚本帮玩家 shoot 拿 0.5% gas 补偿 |

## 用户选择（已确认）

- A1 网页托管版 ✅
- A2 keeperFeeBps 0.5% ✅
- A3 公开战况展示 ✅
- B4 加时赛 ❌
- B5 种子奖池 ❌
- B6 buyAndShoot 散户一键 ✅
- C7 BSC 测试网先试 ✅
- C8 默认参数（5min/0.001/80:20） ✅
- D 世界杯红绿足球场配色 ✅

## 架构

### Phase 1 · 智能合约（✅ 已完成）
- Foundry 项目位于 `/app/contracts/`
- `PenaltyShootoutVault.sol` — 金库主合约
- `PenaltyShootoutVaultFactory.sol` — 工厂合约
- 21 单元测试全通过

### Phase 2 · 网页托管平台（待启动）
```
React 前端（红绿足球主题）
  ├─ 公开仪表盘（不需登录）：当前奖池 / 倒计时 / 历史榜单
  └─ 管理后台（密码登录）：配置 Keeper、查看日志、紧急关停
FastAPI 后端
  ├─ REST API（前端查询）
  ├─ WebSocket（实时推送）
  └─ 后台 Worker（监听 BSC Transfer 事件 + 自动 shoot）
MongoDB
  ├─ rounds 集合（历史轮次）
  ├─ shots 集合（射门记录）
  └─ config 集合（加密的 keeper 私钥、vault 地址等）
```

## 已实现（Phase 1）

| 日期 | 内容 |
|------|------|
| 2026-01 | Foundry 项目搭建 + FLAP 官方接口引入 |
| 2026-01 | PenaltyShootoutVault.sol 主合约（含 V2.1 vaultUISchema） |
| 2026-01 | PenaltyShootoutVaultFactory.sol 工厂（含 V2.1 校验钩子） |
| 2026-01 | 21 单元测试全部通过（含 Mock TaxToken/Processor/Portal） |
| 2026-01 | 部署脚本 DeployFactory.s.sol |
| 2026-01 | README 中文部署文档 |

## 待办（Phase 2）

### P0 · MVP
- [ ] FastAPI 后端搭建
- [ ] BSC Web3 监听 Worker（监听 Transfer + 触发 shoot）
- [ ] React 前端仪表盘
- [ ] WebSocket 实时推送
- [ ] 管理后台 + 加密私钥存储

### P1 · 增强
- [ ] 历史轮次榜单 + 全网战绩
- [ ] 异常告警（Keeper 余额低、RPC 断连）
- [ ] Discord/Telegram 集成（自动播报冠军）
- [ ] 一键 Twitter 分享卡片

### P2 · 商业化
- [ ] 用户登录 + 关注代币列表
- [ ] 多金库支持（一个网站托管多个游戏）

## 测试凭证

无（Phase 1 仅本地 Foundry 测试，无网页）

## 部署信息

- 合约编译：✅ Solc 0.8.20 + via-IR
- 测试通过：✅ 21/21
- 待部署：BSC 测试网 chainId 97

## 下一步行动

请用户确认 Phase 1 → 启动 Phase 2 网页托管平台开发。
