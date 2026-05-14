// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {VaultBaseV2} from "./flap/VaultBaseV2.sol";
import {
    VaultUISchema,
    VaultMethodSchema,
    FieldDescriptor,
    ApproveAction
} from "./flap/IVaultSchemasV1.sol";
import {
    ITaxProcessorLite,
    IFlapTaxTokenLite,
    IPortalTradeV2Lite,
    IERC20Lite
} from "./IFlapLite.sol";

/// @title PenaltyShootoutVault
/// @notice 世界杯主题 FOMO 金库：每次"射门" = 显式调用此合约，
///         5 分钟内无人射门 = 比赛结束，最后射门者获得奖池 80%，剩余 20% 滚入下一轮。
/// @dev    遵循 Flap VaultBaseV2 (v2.1) 规范。
///
/// ── 中文说明 ─────────────────────────────────────────────────────────────
///
/// 玩法机制：
/// 1. 用户/Bot 在 Flap 内盘购买 taxToken 后，需要调用 vault.shoot(player) 来"宣告射门"
/// 2. shoot() 内部触发 TaxProcessor.dispatch()，把累积的税送入金库
/// 3. 仅当本次 dispatch 实际入账 > 0 时，才视为"有效射门"，记录 player 为最后射门者并重置 5 分钟倒计时
/// 4. 5 分钟无人 shoot → 任何人可调用 settleRound() 结算：
///    - winner 获得奖池 80%（扣除 keeperFee）
///    - 20% 自动滚入下一轮作为初始奖池
/// 5. buyAndShoot() 提供一键代理：金库代用户买代币 + 自动 shoot，散户无脑操作
///
/// 佣金机制（FLAP 推荐结构）：
/// - 税率 ≤ 1% (100 bps)：佣金 = msg.value * 6%
/// - 税率 > 1%：佣金 = msg.value * 6 / taxRateBps
///   - 例：2% 税 → 3% 佣金；3% 税 → 2%；10% 税 → 0.6%
///
/// Keeper 激励机制：
/// - 每次 shoot() 调用者会获得 keeperFeeBps (默认 50 bps = 0.5%) 的本轮入账作为 gas 补偿
/// - 鼓励第三方部署监听机器人，提升去信任化程度
///
/// 安全特性：
/// - 重入保护
/// - 失败发奖自动转为 pull-pattern (winner.claim())
/// - Guardian 紧急权限（仅 emergencyWithdraw，绝大多数操作完全去信任）
///
contract PenaltyShootoutVault is VaultBaseV2 {
    // ═══════════════════════════════════════════════════════════════════════════
    // 常量
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice 赢家分成比例（基点，10000 = 100%）
    uint256 public constant WINNER_BPS = 8000; // 80%

    /// @notice 滚入下一轮比例
    uint256 public constant CARRYOVER_BPS = 2000; // 20%

    /// @notice Keeper 激励上限（防滥用）
    uint256 public constant MAX_KEEPER_FEE_BPS = 100; // 1%

    /// @notice 倒计时窗口硬性范围
    uint256 public constant MIN_SHOT_WINDOW = 60; // 1 分钟
    uint256 public constant MAX_SHOT_WINDOW = 24 hours;

    /// @notice 最小射门金额硬性范围（扣完佣金后的有效奖池入账）
    uint256 public constant MIN_SHOT_VALUE_FLOOR = 1e12; // 0.000001 BNB
    uint256 public constant MIN_SHOT_VALUE_CEIL = 10 ether;

    /// @notice 代币创建者（Flap newTokenV6WithVault 的 msg.sender）
    address public immutable creator;

    /// @notice 关联的 Flap V3 税收代币地址（部署后立即可用）
    address public immutable taxToken;

    /// @notice quote token（目前必须为 BNB → address(0)）
    address public immutable quoteToken;

    /// @notice 倒计时窗口（秒），creator 部署时设定
    uint256 public immutable shotWindow;

    /// @notice 最小有效射门金额（扣除佣金后净额，达到此值才重置倒计时）
    uint256 public immutable minShotValue;

    /// @notice 佣金接收地址（不可变）
    address public immutable commissionRecipient;

    /// @notice Keeper 激励比例（基点）
    uint256 public immutable keeperFeeBps;

    /// @notice Flap Portal 地址（用于 buyAndShoot 代买）
    address public immutable flapPortal;

    /// @notice 缓存的税率（从 taxToken 读取，0 表示尚未缓存）
    uint16 public cachedTaxRateBps;

    // ═══════════════════════════════════════════════════════════════════════════
    // 游戏状态
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice 当前轮号（从 1 开始）
    uint256 public currentRound;

    /// @notice 当前轮奖池（已扣佣金、已扣 keeper 激励的净额）
    uint256 public currentPot;

    /// @notice 当前轮最后射门者
    address public lastShooter;

    /// @notice 当前轮射门次数
    uint256 public shotCount;

    /// @notice 当前轮倒计时结束时间戳（unix）
    uint256 public deadline;

    /// @notice 历史轮次记录
    struct Round {
        uint256 roundId;
        address winner;
        uint256 prize;
        uint256 settledAt;
        uint256 totalShots;
    }
    Round[] public rounds;

    /// @notice pull-pattern：发奖失败时存于此，winner 自取
    mapping(address => uint256) public pendingWithdrawals;

    /// @notice 上次 shoot 时的 currentPot 快照，用于追踪"自上次射门以来新增的奖池"
    /// @dev    解决 FLAP 自动 dispatch 在用户买入同 tx 内完成，导致 shoot 时拿不到 dispatched 的问题
    uint256 public lastShotPotMark;

    /// @notice 重入锁
    uint256 private _locked = 1;

    // ═══════════════════════════════════════════════════════════════════════════
    // 事件
    // ═══════════════════════════════════════════════════════════════════════════

    event ShotFired(
        uint256 indexed round,
        address indexed shooter,
        uint256 valueAdded,
        uint256 newDeadline,
        uint256 potAfter,
        uint256 shotIndex
    );

    event GoalScored(
        uint256 indexed round,
        address indexed winner,
        uint256 prize,
        uint256 carriedOver,
        uint256 totalShots
    );

    event TaxReceived(uint256 grossAmount, uint256 fee, uint256 netToPot);

    event KeeperRewarded(address indexed keeper, uint256 reward);

    event PendingPayout(address indexed winner, uint256 amount, string reason);

    event Claimed(address indexed claimer, uint256 amount);

    event EmergencyWithdraw(address indexed to, uint256 amount);

    // ═══════════════════════════════════════════════════════════════════════════
    // Errors
    // ═══════════════════════════════════════════════════════════════════════════

    error InvalidConfig();
    error RoundStillActive(uint256 secondsLeft);
    error NoShotsYet();
    error Reentrant();
    error OnlyGuardian();
    error InvalidPlayer();
    error NoTaxDispatched();
    error NothingToClaim();
    error TransferFailed();
    error InvalidQuoteToken();

    // ═══════════════════════════════════════════════════════════════════════════
    // Modifiers
    // ═══════════════════════════════════════════════════════════════════════════

    modifier nonReentrant() {
        if (_locked == 2) revert Reentrant();
        _locked = 2;
        _;
        _locked = 1;
    }

    modifier onlyGuardian() {
        if (msg.sender != _getGuardian()) revert OnlyGuardian();
        _;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // 构造函数
    // ═══════════════════════════════════════════════════════════════════════════

    /// @param _taxToken   关联的税收代币
    /// @param _quoteToken quote token（必须 = address(0)，即 BNB）
    /// @param _creator    代币创建者
    /// @param _shotWindow 倒计时窗口（秒）
    /// @param _minShotValue 最小有效射门金额
    /// @param _commissionRecipient 佣金接收地址
    /// @param _keeperFeeBps Keeper 激励基点
    /// @param _flapPortal Flap Portal 地址（buyAndShoot 用）
    constructor(
        address _taxToken,
        address _quoteToken,
        address _creator,
        uint256 _shotWindow,
        uint256 _minShotValue,
        address _commissionRecipient,
        uint256 _keeperFeeBps,
        address _flapPortal
    ) {
        if (_taxToken == address(0)) revert InvalidConfig();
        if (_quoteToken != address(0)) revert InvalidQuoteToken();
        if (_creator == address(0)) revert InvalidConfig();
        if (_commissionRecipient == address(0)) revert InvalidConfig();
        if (_flapPortal == address(0)) revert InvalidConfig();
        if (_shotWindow < MIN_SHOT_WINDOW || _shotWindow > MAX_SHOT_WINDOW) revert InvalidConfig();
        if (_minShotValue < MIN_SHOT_VALUE_FLOOR || _minShotValue > MIN_SHOT_VALUE_CEIL) revert InvalidConfig();
        if (_keeperFeeBps > MAX_KEEPER_FEE_BPS) revert InvalidConfig();

        taxToken = _taxToken;
        quoteToken = _quoteToken;
        creator = _creator;
        shotWindow = _shotWindow;
        minShotValue = _minShotValue;
        commissionRecipient = _commissionRecipient;
        keeperFeeBps = _keeperFeeBps;
        flapPortal = _flapPortal;

        currentRound = 1;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // 核心：receive() 接收税收
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice 接收 FLAP 协议派发的税收 BNB
    /// @dev    被 TaxProcessor.dispatch() 调用。被动入账：不重置倒计时，仅扣佣金后累积到当前奖池。
    ///         游戏的"射门"动作必须由用户/Bot 主动调用 shoot() / buyAndShoot() 完成。
    receive() external payable {
        if (msg.value == 0) return;

        // 计算佣金（FLAP 推荐结构）
        uint256 fee = _calculateCommission(msg.value);
        uint256 netAmount = msg.value - fee;

        // 累积到当前奖池
        currentPot += netAmount;

        emit TaxReceived(msg.value, fee, netAmount);

        // 转佣金（失败也不 revert，避免阻塞税收流转）
        if (fee > 0) {
            (bool ok, ) = commissionRecipient.call{value: fee, gas: 30000}("");
            ok; // ignore
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // 核心：shoot —— 玩家主动"射门"
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice 玩家或代理（如 Bot）调用此方法以"射门"
    /// @dev    流程：
    ///         1. 调用 TaxProcessor.dispatch() 尽量将累积税送入金库（可能 FLAP 已自动 dispatch 过）
    ///         2. 验证：currentPot 自上次 shoot 以来增长 >= minShotValue
    ///         3. 满足 → 记录 player 为最后射门者，重置倒计时
    ///         4. 给 msg.sender（Keeper）发放 keeperFeeBps 激励
    /// @param  player 要被记录为最后射门者的地址
    function shoot(address player) external nonReentrant {
        if (player == address(0)) revert InvalidPlayer();

        // 如果上一轮可以结算了，先自动结算
        if (deadline != 0 && block.timestamp >= deadline && lastShooter != address(0)) {
            _settleRoundInternal();
        }

        // 拉取税：尽量触发 dispatch（FLAP 协议可能已经自动 dispatch 过了，此处只是兜底）
        address taxProcessor = IFlapTaxTokenLite(taxToken).taxProcessor();
        try ITaxProcessorLite(taxProcessor).dispatch{gas: 800000}() {} catch {}

        // 用奖池快照差额判断"自上次射门以来新流入的奖池"
        uint256 newAmount = currentPot - lastShotPotMark;
        if (newAmount < minShotValue) revert NoTaxDispatched();

        // 计算 Keeper 激励
        uint256 keeperReward = (newAmount * keeperFeeBps) / 10000;
        currentPot -= keeperReward;

        // 更新快照（扣 keeper 后）
        lastShotPotMark = currentPot;

        // ✅ 有效射门：记录 + 重置倒计时
        lastShooter = player;
        deadline = block.timestamp + shotWindow;
        shotCount += 1;

        // 发 keeper 激励（失败转 pending）
        if (keeperReward > 0) {
            (bool ok, ) = msg.sender.call{value: keeperReward, gas: 30000}("");
            if (!ok) {
                pendingWithdrawals[msg.sender] += keeperReward;
                emit PendingPayout(msg.sender, keeperReward, "keeper transfer failed");
            } else {
                emit KeeperRewarded(msg.sender, keeperReward);
            }
        }

        emit ShotFired(currentRound, player, newAmount - keeperReward, deadline, currentPot, shotCount);
    }

    /// @notice 散户一键模式：金库代理买 taxToken + 自动射门
    /// @dev    用户发送 BNB → 金库通过 Portal 买入 taxToken（接收方为 msg.sender）
    ///         → 买入产生的税自动流入 TaxProcessor → 用户调用 shoot 触发 dispatch + 射门
    ///         整个流程在一次 tx 内完成，散户体验极佳。
    /// @param  minTokenOut 滑点保护：至少买到这么多 taxToken
    function buyAndShoot(uint256 minTokenOut) external payable nonReentrant {
        require(msg.value >= minShotValue, "msg.value too small");

        // 1. 通过 Portal 用 BNB 买 taxToken；产生的税自动累积到 TaxProcessor
        //    买入由本合约执行，代币会先到本合约，然后转给真实玩家
        IPortalTradeV2Lite.ExactInputParams memory p = IPortalTradeV2Lite.ExactInputParams({
            inputToken: address(0),
            outputToken: taxToken,
            inputAmount: msg.value,
            minOutputAmount: minTokenOut,
            permitData: ""
        });

        // 注意：swapExactInput 在 portal 内部把 token 给 msg.sender (本合约)
        IPortalTradeV2Lite(flapPortal).swapExactInput{value: msg.value}(p);

        // 2. 把买到的 taxToken 转给真实玩家
        uint256 tokenBal = IERC20Lite(taxToken).balanceOf(address(this));
        if (tokenBal > 0) {
            bool okTransfer = IERC20Lite(taxToken).transfer(msg.sender, tokenBal);
            if (!okTransfer) revert TransferFailed();
        }

        // 3. 触发 dispatch + 记录 msg.sender 为最后射门者
        _shootInternal(msg.sender);
    }

    /// @dev 内部 shoot 实现（buyAndShoot 走这里，跳过 nonReentrant 因外层已加锁）
    function _shootInternal(address player) internal {
        if (player == address(0)) revert InvalidPlayer();

        if (deadline != 0 && block.timestamp >= deadline && lastShooter != address(0)) {
            _settleRoundInternal();
        }

        uint256 potBefore = currentPot;

        address taxProcessor = IFlapTaxTokenLite(taxToken).taxProcessor();
        try ITaxProcessorLite(taxProcessor).dispatch{gas: 800000}() {} catch {}

        uint256 dispatched = currentPot - potBefore;
        if (dispatched == 0) revert NoTaxDispatched();

        uint256 keeperReward = (dispatched * keeperFeeBps) / 10000;
        uint256 netToShot = dispatched - keeperReward;

        currentPot -= keeperReward;

        if (netToShot < minShotValue) {
            currentPot += keeperReward;
            revert NoTaxDispatched();
        }

        lastShooter = player;
        deadline = block.timestamp + shotWindow;
        shotCount += 1;

        if (keeperReward > 0) {
            (bool ok, ) = msg.sender.call{value: keeperReward, gas: 30000}("");
            if (!ok) {
                pendingWithdrawals[msg.sender] += keeperReward;
                emit PendingPayout(msg.sender, keeperReward, "keeper transfer failed");
            } else {
                emit KeeperRewarded(msg.sender, keeperReward);
            }
        }

        emit ShotFired(currentRound, player, netToShot, deadline, currentPot, shotCount);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // 核心：settleRound —— 比赛结束结算
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice 倒计时归零后，任何人可调用此方法触发结算
    function settleRound() external nonReentrant {
        if (lastShooter == address(0)) revert NoShotsYet();
        if (block.timestamp < deadline) {
            revert RoundStillActive(deadline - block.timestamp);
        }
        _settleRoundInternal();
    }

    /// @dev 实际结算逻辑
    function _settleRoundInternal() internal {
        address winner = lastShooter;
        uint256 pot = currentPot;
        uint256 prize = (pot * WINNER_BPS) / 10000;
        uint256 carryOver = pot - prize; // 自动等于 20%

        // 记录历史
        rounds.push(Round({
            roundId: currentRound,
            winner: winner,
            prize: prize,
            settledAt: block.timestamp,
            totalShots: shotCount
        }));

        emit GoalScored(currentRound, winner, prize, carryOver, shotCount);

        // 重置状态准备下一轮
        currentRound += 1;
        currentPot = carryOver;
        lastShotPotMark = carryOver;  // 滚入的 BNB 算作下一轮起始基线
        lastShooter = address(0);
        deadline = 0;
        shotCount = 0;

        // 发奖（失败转 pending）
        if (prize > 0) {
            (bool ok, ) = winner.call{value: prize, gas: 50000}("");
            if (!ok) {
                pendingWithdrawals[winner] += prize;
                emit PendingPayout(winner, prize, "winner transfer failed");
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Pull-pattern 取款
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice 若自动发奖失败，赢家/keeper 自取
    function claim() external nonReentrant {
        uint256 amount = pendingWithdrawals[msg.sender];
        if (amount == 0) revert NothingToClaim();
        pendingWithdrawals[msg.sender] = 0;
        (bool ok, ) = msg.sender.call{value: amount}("");
        if (!ok) {
            pendingWithdrawals[msg.sender] = amount;
            revert TransferFailed();
        }
        emit Claimed(msg.sender, amount);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // 紧急权限（仅 Guardian）
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice 紧急情况下 Guardian 可提取金库 BNB（FLAP 规范要求）
    /// @dev    仅可在出现协议级 bug 时使用，正常情况下永不调用
    function emergencyWithdrawNative(address to) external onlyGuardian nonReentrant {
        if (to == address(0)) revert InvalidConfig();
        uint256 bal = address(this).balance;
        if (bal == 0) return;
        (bool ok, ) = to.call{value: bal}("");
        if (!ok) revert TransferFailed();
        emit EmergencyWithdraw(to, bal);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // 视图函数
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice 倒计时剩余秒数（0 表示已可结算或尚未开始）
    function timeRemaining() public view returns (uint256) {
        if (deadline == 0 || block.timestamp >= deadline) return 0;
        return deadline - block.timestamp;
    }

    /// @notice 历史轮次总数
    function roundHistoryLength() external view returns (uint256) {
        return rounds.length;
    }

    /// @notice 分页查询历史轮次
    function getRecentRounds(uint256 offset, uint256 limit)
        external
        view
        returns (Round[] memory page)
    {
        uint256 total = rounds.length;
        if (offset >= total) return new Round[](0);
        uint256 endExclusive = total - offset;
        uint256 startInclusive = endExclusive > limit ? endExclusive - limit : 0;
        uint256 size = endExclusive - startInclusive;
        page = new Round[](size);
        for (uint256 i = 0; i < size; ++i) {
            // 倒序：最近的在前
            page[i] = rounds[endExclusive - 1 - i];
        }
    }

    /// @notice 查询单轮信息
    function getRound(uint256 roundId) external view returns (Round memory) {
        // roundId 从 1 开始，rounds[0] 是第 1 轮
        require(roundId >= 1 && roundId <= rounds.length, "invalid roundId");
        return rounds[roundId - 1];
    }

    /// @notice 待发放的累积税（在 TaxProcessor 内尚未 dispatch 的部分）
    function pendingTaxInProcessor() external view returns (uint256) {
        try IFlapTaxTokenLite(taxToken).taxProcessor() returns (address proc) {
            if (proc == address(0)) return 0;
            try ITaxProcessorLite(proc).marketQuoteBalance() returns (uint256 bal) {
                return bal;
            } catch {
                return 0;
            }
        } catch {
            return 0;
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // FLAP 规范方法：description / vaultUISchema
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice 动态描述（用于 Flap.sh 前端展示）
    function description() public view override returns (string memory) {
        return string(
            abi.encodePacked(
                unicode"⚽ 点球大战金库 / Penalty Shootout Vault\n",
                unicode"玩法：每次调用 shoot(player) 即可"
                unicode"射门"
                unicode"，5 分钟内无人射门则最后射门者获得奖池 80%，剩余 20% 滚入下一轮。\n",
                unicode"Rules: Call shoot(player) to score. ",
                unicode"If no shot in ", _uint2str(shotWindow), unicode" seconds, ",
                unicode"the last shooter wins 80% of the pot, 20% rolls into the next round.\n",
                unicode"当前轮 / Round: #", _uint2str(currentRound),
                unicode" | 奖池 / Pot: ", _weiToBnbStr(currentPot), unicode" BNB",
                unicode" | 倒计时 / Countdown: ", _uint2str(timeRemaining()), unicode" s",
                unicode" | 最后射门 / LastShooter: ", _addr2str(lastShooter), "\n",
                unicode"佣金 / Commission: 税率≤1% 收 6% | 税率>1% 收 6/taxRateBps",
                unicode" | Keeper 激励 / Keeper Fee: ", _uint2str(keeperFeeBps), unicode" bps\n",
                unicode"⚠ tx.origin / msg.sender 归属由调用者显式传入 player，"
                unicode"建议通过官方 Bot 或 buyAndShoot() 进入游戏。"
            )
        );
    }

    /// @notice 自动 UI 渲染 schema (Flap V2.1)
    function vaultUISchema() public pure override returns (VaultUISchema memory schema) {
        schema.vaultType = "PenaltyShootoutVault";
        schema.description = unicode"⚽ 世界杯点球大战金库 / FOMO Penalty Shootout — "
            unicode"购买 taxToken 后调用 shoot(player) 宣告射门，5 分钟无新射门则最后射门者赢得奖池 80%。 / "
            unicode"After buying taxToken, call shoot(player) to score. "
            unicode"If no shots for 5 minutes, last shooter wins 80% of the pot.";

        schema.methods = new VaultMethodSchema[](9);

        // ─── View: currentRound ───
        schema.methods[0].name = "currentRound";
        schema.methods[0].description = unicode"当前轮号 / Current round number.";
        schema.methods[0].inputs = new FieldDescriptor[](0);
        schema.methods[0].outputs = new FieldDescriptor[](1);
        schema.methods[0].outputs[0] = FieldDescriptor("round", "uint256", "Round #", 0);
        schema.methods[0].approvals = new ApproveAction[](0);

        // ─── View: currentPot ───
        schema.methods[1].name = "currentPot";
        schema.methods[1].description = unicode"当前奖池 (BNB) / Current pot in BNB.";
        schema.methods[1].inputs = new FieldDescriptor[](0);
        schema.methods[1].outputs = new FieldDescriptor[](1);
        schema.methods[1].outputs[0] = FieldDescriptor("pot", "uint256", "Current pot", 18);
        schema.methods[1].approvals = new ApproveAction[](0);

        // ─── View: timeRemaining ───
        schema.methods[2].name = "timeRemaining";
        schema.methods[2].description = unicode"倒计时剩余秒数 / Seconds until round can be settled.";
        schema.methods[2].inputs = new FieldDescriptor[](0);
        schema.methods[2].outputs = new FieldDescriptor[](1);
        schema.methods[2].outputs[0] = FieldDescriptor("seconds", "uint256", "Seconds left", 0);
        schema.methods[2].approvals = new ApproveAction[](0);

        // ─── View: lastShooter ───
        schema.methods[3].name = "lastShooter";
        schema.methods[3].description = unicode"当前轮最后射门者 / Last shooter of current round.";
        schema.methods[3].inputs = new FieldDescriptor[](0);
        schema.methods[3].outputs = new FieldDescriptor[](1);
        schema.methods[3].outputs[0] = FieldDescriptor("player", "address", "Last shooter address", 0);
        schema.methods[3].approvals = new ApproveAction[](0);

        // ─── View: shotCount ───
        schema.methods[4].name = "shotCount";
        schema.methods[4].description = unicode"本轮已发生的有效射门次数 / Total shots in current round.";
        schema.methods[4].inputs = new FieldDescriptor[](0);
        schema.methods[4].outputs = new FieldDescriptor[](1);
        schema.methods[4].outputs[0] = FieldDescriptor("count", "uint256", "Shot count", 0);
        schema.methods[4].approvals = new ApproveAction[](0);

        // ─── View: pendingTaxInProcessor ───
        schema.methods[5].name = "pendingTaxInProcessor";
        schema.methods[5].description = unicode"TaxProcessor 中待 dispatch 的累积税 / Pending tax in TaxProcessor.";
        schema.methods[5].inputs = new FieldDescriptor[](0);
        schema.methods[5].outputs = new FieldDescriptor[](1);
        schema.methods[5].outputs[0] = FieldDescriptor("pending", "uint256", "Pending BNB", 18);
        schema.methods[5].approvals = new ApproveAction[](0);

        // ─── Write: shoot(address) ───
        schema.methods[6].name = "shoot";
        schema.methods[6].description = unicode"宣告射门：触发税收 dispatch + 记录 player 为最后射门者，"
            unicode"调用者(msg.sender)会获得 keeper 激励。/ "
            unicode"Score a shot: triggers tax dispatch and records player as last shooter. "
            unicode"Caller earns keeper reward.";
        schema.methods[6].inputs = new FieldDescriptor[](1);
        schema.methods[6].inputs[0] = FieldDescriptor("player", "address", unicode"射门玩家地址 / Player address", 0);
        schema.methods[6].outputs = new FieldDescriptor[](0);
        schema.methods[6].approvals = new ApproveAction[](0);
        schema.methods[6].isWriteMethod = true;

        // ─── Write: buyAndShoot(uint256) ───
        schema.methods[7].name = "buyAndShoot";
        schema.methods[7].description = unicode"一键模式：金库代您买 taxToken 并自动射门。/ "
            unicode"One-click: Vault buys taxToken on your behalf and auto-shoots.";
        schema.methods[7].inputs = new FieldDescriptor[](2);
        schema.methods[7].inputs[0] = FieldDescriptor("minTokenOut", "uint256", unicode"最少买到的代币数（滑点保护） / Min tokens out", 18);
        schema.methods[7].inputs[1] = FieldDescriptor("bnbIn", "msg.value", unicode"投入 BNB / BNB to send", 18);
        schema.methods[7].outputs = new FieldDescriptor[](0);
        schema.methods[7].approvals = new ApproveAction[](0);
        schema.methods[7].isWriteMethod = true;

        // ─── Write: settleRound ───
        schema.methods[8].name = "settleRound";
        schema.methods[8].description = unicode"倒计时归零后，任何人可触发结算。/ "
            unicode"Anyone can settle once countdown hits zero.";
        schema.methods[8].inputs = new FieldDescriptor[](0);
        schema.methods[8].outputs = new FieldDescriptor[](0);
        schema.methods[8].approvals = new ApproveAction[](0);
        schema.methods[8].isWriteMethod = true;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // 内部工具
    // ═══════════════════════════════════════════════════════════════════════════

    /// @dev FLAP 官方推荐佣金计算
    function _calculateCommission(uint256 amount) internal returns (uint256 fee) {
        // 懒加载税率
        uint16 taxRate = cachedTaxRateBps;
        if (taxRate == 0) {
            try IFlapTaxTokenLite(taxToken).taxRate() returns (uint16 rate) {
                if (rate > 0) {
                    cachedTaxRateBps = rate;
                    taxRate = rate;
                }
            } catch {}
        }

        if (taxRate == 0) {
            // 无法获取税率，保守按 6% 收
            return (amount * 600) / 10000;
        }

        if (taxRate <= 100) {
            // ≤ 1%：佣金 = 6%
            return (amount * 600) / 10000;
        } else {
            // > 1%：佣金 = 6 / taxRateBps
            return (amount * 6) / taxRate;
        }
    }

    /// @dev uint → string（仅用于 description）
    function _uint2str(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 j = v;
        uint256 len;
        while (j != 0) { len++; j /= 10; }
        bytes memory bstr = new bytes(len);
        while (v != 0) {
            len -= 1;
            bstr[len] = bytes1(uint8(48 + (v % 10)));
            v /= 10;
        }
        return string(bstr);
    }

    /// @dev wei → "X.XXXX" BNB
    function _weiToBnbStr(uint256 wei_) internal pure returns (string memory) {
        uint256 whole = wei_ / 1e18;
        uint256 frac = (wei_ % 1e18) / 1e14; // 4 位小数
        return string(abi.encodePacked(_uint2str(whole), ".", _padZero(frac, 4)));
    }

    /// @dev address → 0x...
    function _addr2str(address a) internal pure returns (string memory) {
        if (a == address(0)) return "0x0000...0000";
        bytes20 b = bytes20(a);
        bytes16 hexchars = "0123456789abcdef";
        bytes memory s = new bytes(42);
        s[0] = "0"; s[1] = "x";
        for (uint256 i = 0; i < 20; ++i) {
            s[2 + i*2] = hexchars[uint8(b[i] >> 4)];
            s[3 + i*2] = hexchars[uint8(b[i] & 0x0f)];
        }
        return string(s);
    }

    function _padZero(uint256 v, uint256 width) internal pure returns (string memory) {
        bytes memory s = new bytes(width);
        for (uint256 k = 0; k < width; ++k) s[k] = "0";
        uint256 i = width;
        while (v != 0 && i > 0) {
            i--;
            s[i] = bytes1(uint8(48 + (v % 10)));
            v /= 10;
        }
        return string(s);
    }
}
