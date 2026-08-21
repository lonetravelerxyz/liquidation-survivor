// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "../interfaces/IERC20.sol";
import {DataTypes} from "../interfaces/IAaveV3.sol";
import {MockERC20} from "./MockERC20.sol";

/// @notice Tiny Aave-V3-shaped lending pool for the X Layer testnet (Aave is mainnet-only there).
///         Implements exactly the surface SurvivalGuard + the dApp use: supply/borrow/repay, per-asset
///         price + liquidation threshold, getUserAccountData, getReserveData, getAssetPrice.
///         Prices are owner-settable so a demo can replay a market dip. Health factor maths matches Aave:
///         HF = sum(collateral_i * LT_i) / sum(debt_j), all in 8-decimal USD.
contract MockPool {
    struct Reserve {
        bool listed;
        uint256 price; // 8-dec USD
        uint16 liquidationThresholdBps;
        uint16 ltvBps;
        MockERC20 variableDebtToken; // mintable/burnable accounting token
        uint16 id;
    }

    address public owner;
    address[] public reserveList;
    mapping(address => Reserve) public reserves;
    mapping(address => mapping(address => uint256)) public supplied; // user => asset => amount
    uint256 private constant WAD = 1e18;
    uint256 private constant BPS = 10_000;

    event ReserveListed(address indexed asset, uint256 price, uint16 lt, uint16 ltv, address debtToken);
    event PriceSet(address indexed asset, uint256 price);
    event Supply(address indexed user, address indexed asset, uint256 amount);
    event Withdraw(address indexed user, address indexed asset, uint256 amount);
    event Borrow(address indexed user, address indexed asset, uint256 amount);
    event Repay(address indexed user, address indexed asset, uint256 amount, address indexed payer);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    // ------------------------------------------------------------ admin
    function listReserve(address asset, uint256 price, uint16 ltBps, uint16 ltvBps) external onlyOwner {
        require(!reserves[asset].listed, "listed");
        MockERC20 dt = new MockERC20("Mock variable debt token", "vDebt", IERC20(asset).decimals());
        reserves[asset] = Reserve({
            listed: true,
            price: price,
            liquidationThresholdBps: ltBps,
            ltvBps: ltvBps,
            variableDebtToken: dt,
            id: uint16(reserveList.length)
        });
        reserveList.push(asset);
        emit ReserveListed(asset, price, ltBps, ltvBps, address(dt));
    }

    function setPrice(address asset, uint256 price) external onlyOwner {
        require(reserves[asset].listed, "unlisted");
        reserves[asset].price = price;
        emit PriceSet(asset, price);
    }

    function setLiquidationThreshold(address asset, uint16 ltBps) external onlyOwner {
        reserves[asset].liquidationThresholdBps = ltBps;
    }

    // ------------------------------------------------------------ user
    function supply(address asset, uint256 amount, address onBehalfOf, uint16) external {
        require(reserves[asset].listed, "unlisted");
        require(IERC20(asset).transferFrom(msg.sender, address(this), amount), "transferFrom");
        supplied[onBehalfOf][asset] += amount;
        emit Supply(onBehalfOf, asset, amount);
    }

    function withdraw(address asset, uint256 amount, address to) external returns (uint256) {
        supplied[msg.sender][asset] -= amount;
        require(IERC20(asset).transfer(to, amount), "transfer");
        (,,,,, uint256 hf) = getUserAccountData(msg.sender);
        require(hf >= WAD, "HF < 1");
        emit Withdraw(msg.sender, asset, amount);
        return amount;
    }

    function borrow(address asset, uint256 amount, uint256, uint16, address onBehalfOf) external {
        require(onBehalfOf == msg.sender, "self only");
        Reserve storage r = reserves[asset];
        require(r.listed, "unlisted");
        r.variableDebtToken.mint(msg.sender, amount);
        (uint256 col, uint256 debt,, uint256 lt,,) = getUserAccountData(msg.sender);
        // borrowing allowed while HF stays >= 1 (demo pool; ignores LTV to make dips easy to stage)
        require((col * lt) / BPS >= debt, "undercollateralised");
        require(IERC20(asset).balanceOf(address(this)) >= amount, "no liquidity");
        require(IERC20(asset).transfer(msg.sender, amount), "transfer");
        emit Borrow(msg.sender, asset, amount);
    }

    /// @dev Aave semantics: repays min(amount, debt) from msg.sender on behalf of onBehalfOf; returns paid.
    function repay(address asset, uint256 amount, uint256, address onBehalfOf) external returns (uint256) {
        Reserve storage r = reserves[asset];
        require(r.listed, "unlisted");
        uint256 debt = r.variableDebtToken.balanceOf(onBehalfOf);
        uint256 paid = amount > debt ? debt : amount;
        require(paid > 0, "no debt");
        require(IERC20(asset).transferFrom(msg.sender, address(this), paid), "transferFrom");
        r.variableDebtToken.burn(onBehalfOf, paid);
        emit Repay(onBehalfOf, asset, paid, msg.sender);
        return paid;
    }

    /// @notice Seed liquidity so borrows can be served (anyone; testnet).
    function seed(address asset, uint256 amount) external {
        require(IERC20(asset).transferFrom(msg.sender, address(this), amount), "transferFrom");
    }

    // ------------------------------------------------------------ views (Aave-shaped)
    struct Agg {
        uint256 col;
        uint256 debt;
        uint256 wLT;
        uint256 wLTV;
    }

    function _aggregate(address user) internal view returns (Agg memory a) {
        for (uint256 i = 0; i < reserveList.length; i++) {
            address asset = reserveList[i];
            Reserve storage r = reserves[asset];
            uint256 dec = 10 ** IERC20(asset).decimals();
            uint256 s = supplied[user][asset];
            if (s > 0) {
                uint256 v = (s * r.price) / dec;
                a.col += v;
                a.wLT += v * r.liquidationThresholdBps;
                a.wLTV += v * r.ltvBps;
            }
            uint256 d = r.variableDebtToken.balanceOf(user);
            if (d > 0) a.debt += (d * r.price) / dec;
        }
    }

    function getUserAccountData(address user)
        public
        view
        returns (
            uint256 totalCollateralBase,
            uint256 totalDebtBase,
            uint256 availableBorrowsBase,
            uint256 currentLiquidationThreshold,
            uint256 ltv,
            uint256 healthFactor
        )
    {
        Agg memory a = _aggregate(user);
        totalCollateralBase = a.col;
        totalDebtBase = a.debt;
        if (a.col > 0) {
            currentLiquidationThreshold = a.wLT / a.col;
            ltv = a.wLTV / a.col;
        }
        uint256 borrowCap = (a.col * ltv) / BPS;
        availableBorrowsBase = borrowCap > a.debt ? borrowCap - a.debt : 0;
        healthFactor =
            a.debt == 0 ? type(uint256).max : (a.col * currentLiquidationThreshold * WAD) / (BPS * a.debt);
    }

    function getReserveData(address asset) external view returns (DataTypes.ReserveDataLegacy memory d) {
        Reserve storage r = reserves[asset];
        d.id = r.id;
        d.variableDebtTokenAddress = address(r.variableDebtToken);
        // aToken: we don't mint receipt tokens; expose the pool itself so UIs show a non-zero address.
        d.aTokenAddress = r.listed ? address(this) : address(0);
    }

    /// @notice IAaveOracle-compatible, so MockPool can serve as both POOL and ORACLE for SurvivalGuard.
    function getAssetPrice(address asset) external view returns (uint256) {
        return reserves[asset].price;
    }

    function getReservesList() external view returns (address[] memory) {
        return reserveList;
    }

    function variableDebtToken(address asset) external view returns (address) {
        return address(reserves[asset].variableDebtToken);
    }
}
