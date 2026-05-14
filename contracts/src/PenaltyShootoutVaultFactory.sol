// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {VaultFactoryBaseV2} from "./flap/VaultFactoryBaseV2.sol";
import {VaultDataSchema, FieldDescriptor, FactoryPolicy} from "./flap/IVaultSchemasV1.sol";
import {IVaultPortalTypes} from "./flap/IVaultPortal.sol";
import {PenaltyShootoutVault} from "./PenaltyShootoutVault.sol";

/// @title PenaltyShootoutVaultFactory
/// @notice 点球大战金库工厂（FLAP V2.1）
/// @dev    遵循 VaultFactoryBaseV2 规范，符合 Flap VaultPortal 调用方式。
///
/// ── vaultData 编码 ─────────────────────────────────────────────────────────
///
/// abi.encode(
///   uint256 shotWindow,       // 倒计时窗口（秒），范围 [60, 86400]
///   uint256 minShotValue,     // 最小有效射门金额，范围 [1e12, 10 ether]
///   address commissionRecipient, // 佣金接收地址（不可变）
///   uint256 keeperFeeBps      // Keeper 激励基点，范围 [0, 100]
/// )
///
contract PenaltyShootoutVaultFactory is VaultFactoryBaseV2 {
    /// @notice 工厂版本（部署后不变）
    string public constant VERSION = "PenaltyShootoutVault-V1.0";

    /// @notice 已部署金库列表
    address[] public deployedVaults;

    /// @notice taxToken → vault 映射
    mapping(address => address) public vaultOf;

    event VaultCreated(
        address indexed vault,
        address indexed taxToken,
        address indexed creator,
        uint256 shotWindow,
        uint256 minShotValue,
        address commissionRecipient,
        uint256 keeperFeeBps
    );

    error UnsupportedQuoteToken();
    error InvalidVaultData(string reason);

    // ═══════════════════════════════════════════════════════════════════════════
    // IVaultFactory 必须实现
    // ═══════════════════════════════════════════════════════════════════════════

    function newVault(
        address taxToken,
        address quoteToken,
        address creator,
        bytes calldata vaultData
    ) external override returns (address vault) {
        // 仅 VaultPortal 可调用
        if (msg.sender != _getVaultPortal()) revert OnlyVaultPortal();
        if (taxToken == address(0) || creator == address(0)) revert ZeroAddress();
        if (quoteToken != address(0)) revert UnsupportedQuoteToken();

        // 解码 vaultData
        (
            uint256 shotWindow,
            uint256 minShotValue,
            address commissionRecipient,
            uint256 keeperFeeBps
        ) = abi.decode(vaultData, (uint256, uint256, address, uint256));

        // commissionRecipient 默认 creator
        if (commissionRecipient == address(0)) {
            commissionRecipient = creator;
        }

        // 部署金库
        PenaltyShootoutVault v = new PenaltyShootoutVault(
            taxToken,
            quoteToken,
            creator,
            shotWindow,
            minShotValue,
            commissionRecipient,
            keeperFeeBps,
            _getPortalForCurrentChain()
        );

        vault = address(v);
        deployedVaults.push(vault);
        vaultOf[taxToken] = vault;

        emit VaultCreated(
            vault,
            taxToken,
            creator,
            shotWindow,
            minShotValue,
            commissionRecipient,
            keeperFeeBps
        );
    }

    function isQuoteTokenSupported(address quoteToken) external pure override returns (bool) {
        return quoteToken == address(0); // 仅 BNB
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // V2 自动 UI 渲染
    // ═══════════════════════════════════════════════════════════════════════════

    function vaultDataSchema() public pure override returns (VaultDataSchema memory schema) {
        schema.description = unicode"⚽ 点球大战金库工厂 — 创建一个 FOMO 点球大战金库。"
            unicode"5 分钟内无人射门，最后射门者获得奖池 80%，剩余 20% 滚入下一轮。/ "
            unicode"Penalty Shootout Vault Factory — last shooter wins 80% of the pot if no one shoots "
            unicode"within the countdown window. 20% rolls into the next round.";

        schema.fields = new FieldDescriptor[](4);
        schema.fields[0] = FieldDescriptor(
            "shotWindow",
            "uint256",
            unicode"倒计时窗口（秒），范围 60 ~ 86400，默认 300 (5 分钟) / "
            unicode"Countdown window in seconds, range 60-86400, default 300 (5 min)",
            0
        );
        schema.fields[1] = FieldDescriptor(
            "minShotValue",
            "uint256",
            unicode"最小有效射门金额(BNB)，范围 0.000001 ~ 10，默认 0.001 / "
            unicode"Minimum effective shot value in BNB, range 0.000001-10, default 0.001",
            18
        );
        schema.fields[2] = FieldDescriptor(
            "commissionRecipient",
            "address",
            unicode"佣金接收地址（留 0 则默认为 creator） / "
            unicode"Commission recipient (0 = creator)",
            0
        );
        schema.fields[3] = FieldDescriptor(
            "keeperFeeBps",
            "uint256",
            unicode"Keeper 激励基点 (0-100)，默认 50 (0.5%) / "
            unicode"Keeper fee in bps (0-100), default 50 (0.5%)",
            0
        );
        schema.isArray = false;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // V2.1 校验钩子
    // ═══════════════════════════════════════════════════════════════════════════

    function onBeforeNewTokenV6WithVault(IVaultPortalTypes.NewTokenV6WithVaultParams calldata params)
        external
        pure
        override
        returns (bool success, string memory reason)
    {
        // 强制 quoteToken 必须为 BNB
        if (params.quoteToken != address(0)) {
            return (false, "PenaltyShootoutVault only supports BNB as quoteToken");
        }
        return (true, "");
    }

    function tokenCreationPolicies()
        public
        pure
        override
        returns (FactoryPolicy[] memory policies)
    {
        policies = new FactoryPolicy[](1);
        policies[0] = FactoryPolicy({
            target: "quoteToken",
            operator: "eq",
            value: abi.encode(address(0)),
            description: unicode"必须使用 BNB 作为 quoteToken / Quote token must be BNB (address(0))."
        });
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // 视图
    // ═══════════════════════════════════════════════════════════════════════════

    function deployedVaultsCount() external view returns (uint256) {
        return deployedVaults.length;
    }

    /// @dev BSC 主网 / 测试网的 Portal 地址（Flap V6）
    function _getPortalForCurrentChain() internal view returns (address) {
        uint256 chainId = block.chainid;
        if (chainId == 56) {
            return 0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0; // BSC mainnet Portal
        } else if (chainId == 97) {
            return 0x5bEacaF7ABCbB3aB280e80D007FD31fcE26510e9; // BSC testnet Portal
        }
        revert UnsupportedChain(chainId);
    }
}
