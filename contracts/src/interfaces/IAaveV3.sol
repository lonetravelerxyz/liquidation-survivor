// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Minimal Aave V3 surface used by SurvivalGuard. Mirrors aave-v3-origin ABI.
library DataTypes {
    struct ReserveConfigurationMap {
        uint256 data;
    }

    // ReserveDataLegacy — the struct returned by IPool.getReserveData in Aave v3.1+ (field order matters).
    struct ReserveDataLegacy {
        ReserveConfigurationMap configuration;
        uint128 liquidityIndex;
        uint128 currentLiquidityRate;
        uint128 variableBorrowIndex;
        uint128 currentVariableBorrowRate;
        uint128 currentStableBorrowRate;
        uint40 lastUpdateTimestamp;
        uint16 id;
        address aTokenAddress;
        address stableDebtTokenAddress;
        address variableDebtTokenAddress;
        address interestRateStrategyAddress;
        uint128 accruedToTreasury;
        uint128 unbacked;
        uint128 isolationModeTotalDebt;
    }
}

interface IPool {
    function getUserAccountData(address user)
        external
        view
        returns (
            uint256 totalCollateralBase,
            uint256 totalDebtBase,
            uint256 availableBorrowsBase,
            uint256 currentLiquidationThreshold,
            uint256 ltv,
            uint256 healthFactor
        );

    function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf)
        external
        returns (uint256);

    function getReserveData(address asset) external view returns (DataTypes.ReserveDataLegacy memory);
}

interface IAaveOracle {
    /// @return price in base currency units (USD, 8 decimals on X Layer)
    function getAssetPrice(address asset) external view returns (uint256);
}
