# ⚽ Penalty Shootout Vault · 点球大战金库

> 蹭世界杯热度的 FOMO 玩法 ｜ Flap VaultPortal V2.1 兼容 ｜ BNB Chain

## 一、玩法说明

**核心机制：**
- 任何人/Bot 在 Flap 内盘购买 taxToken 后，调用 `vault.shoot(player)` 即为"射门"
- **5 分钟内无人射门** → 比赛结束，最后射门者获得奖池 **80%**
- 剩余 **20%** 自动滚入下一轮，作为下一轮起始奖池
- 比赛永不停止，回合循环

**关键功能：**
| 入口 | 说明 |
|------|------|
| `shoot(player)` | 由 Keeper Bot 或玩家自己调用，显式指定射门者地址 |
| `buyAndShoot(minTokenOut)` | 一键模式：金库代用户买代币 + 自动射门 |
| `settleRound()` | 倒计时归零后任何人可触发结算（去信任化） |
| `claim()` | 万一发奖失败，赢家自取 |

## 二、技术栈

- Solidity 0.8.20 + Foundry
- Flap VaultBaseV2 + VaultFactoryBaseV2 (v2.1 规范)
- OpenZeppelin Contracts

## 三、本地开发

```bash
# 编译
forge build

# 测试（21 个用例）
forge test -vv
```

## 四、部署到 BSC 测试网

```bash
export PRIVATE_KEY=0x...
forge script script/DeployFactory.s.sol:DeployFactory \
  --rpc-url https://data-seed-prebsc-1-s1.binance.org:8545 \
  --private-key $PRIVATE_KEY \
  --broadcast
```

记录返回的 Factory 地址，在 Flap.sh 发币时填入。

## 五、佣金机制（FLAP 推荐）

```
税率 ≤ 1%: 佣金 = msg.value × 6%
税率 > 1%: 佣金 = msg.value × 6 / taxRateBps
```

## 六、参数（部署时由 creator 设定）

| 参数 | 范围 | 默认 |
|------|------|------|
| shotWindow | 60-86400 秒 | 300 |
| minShotValue | 1e12-10 ether | 1e15 (0.001 BNB) |
| commissionRecipient | any | creator |
| keeperFeeBps | 0-100 | 50 (0.5%) |

固定：WINNER_BPS=8000, CARRYOVER_BPS=2000.

## 七、配套网页托管

参见 `/app/frontend/` 与 `/app/backend/`：实时仪表盘 + 7x24 监听 Bot，让玩家直接打开网页即可参与，无需本地脚本。

## License

MIT
