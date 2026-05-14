// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice 极简 TaxProcessor 接口（仅金库需要的方法）
interface ITaxProcessorLite {
    function dispatch() external;
    function marketQuoteBalance() external view returns (uint256);
    function marketAddress() external view returns (address);
}

/// @notice 极简 FlapTaxTokenV3 接口（仅金库需要的方法）
interface IFlapTaxTokenLite {
    function taxProcessor() external view returns (address);
    function taxRate() external view returns (uint16);
}

/// @notice 极简 Portal Trade V2 接口（用于 buyAndShoot 代理买入）
interface IPortalTradeV2Lite {
    struct ExactInputParams {
        address inputToken;
        address outputToken;
        uint256 inputAmount;
        uint256 minOutputAmount;
        bytes permitData;
    }

    function swapExactInput(ExactInputParams calldata params)
        external
        payable
        returns (uint256 outputAmount);
}

interface IERC20Lite {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}
