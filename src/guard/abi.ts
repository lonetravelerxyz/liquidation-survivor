import { parseAbi } from "viem";

// Verified against contracts/out/SurvivalGuard.sol/SurvivalGuard.json (forge build, 2026-08-19).
export const SURVIVAL_GUARD_ABI = parseAbi([
  "struct Plan { address debtAsset; uint256 triggerHF; uint256 targetHF; uint256 maxRepayPerProtect; uint32 cooldown; bool active; }",
  "function enroll(Plan plan)",
  "function update(Plan plan)",
  "function disable()",
  "function protect(address user) returns (uint256 repaid)",
  "function previewProtect(address user) view returns (bool eligible, string reason, uint256 hf, uint256 repayAmount)",
  "function plans(address user) view returns (Plan)",
  "function lastProtectAt(address user) view returns (uint40)",
  "function feeBps() view returns (uint16)",
  "function paused() view returns (bool)",
  "function owner() view returns (address)",
  "function POOL() view returns (address)",
  "function ORACLE() view returns (address)",
  "function MAX_FEE_BPS() view returns (uint16)",
  "function setFeeBps(uint16 bps)",
  "function setPaused(bool p)",
  "event Enrolled(address indexed user, Plan plan)",
  "event Updated(address indexed user, Plan plan)",
  "event Disabled(address indexed user)",
  "event Protected(address indexed user, address indexed debtAsset, uint256 repaid, uint256 fee, uint256 hfBefore, uint256 hfAfter, address indexed keeper)",
  "event FeeUpdated(uint16 feeBps)",
  "event PausedSet(bool paused)",
  "error NotOwner()",
  "error PausedError()",
  "error InvalidPlan(string reason)",
  "error NotActive()",
  "error Cooldown(uint256 availableAt)",
  "error HealthFactorAboveTrigger(uint256 hf, uint256 trigger)",
  "error NothingToRepay(string reason)",
  "error HealthFactorNotImproved(uint256 before, uint256 after_)",
  "error FeeTooHigh()",
  "error TransferFailed()",
]);

// Verified against contracts/out/MockPool.sol/MockPool.json.
export const MOCK_POOL_ABI = parseAbi([
  "function owner() view returns (address)",
  "function listReserve(address asset, uint256 price, uint16 ltBps, uint16 ltvBps)",
  "function setPrice(address asset, uint256 price)",
  "function setLiquidationThreshold(address asset, uint16 ltBps)",
  "function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)",
  "function withdraw(address asset, uint256 amount, address to) returns (uint256)",
  "function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)",
  "function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf) returns (uint256)",
  "function seed(address asset, uint256 amount)",
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
  "function getAssetPrice(address asset) view returns (uint256)",
  "function getReservesList() view returns (address[])",
  "function variableDebtToken(address asset) view returns (address)",
  "function supplied(address user, address asset) view returns (uint256)",
  "function reserves(address asset) view returns (bool listed, uint256 price, uint16 liquidationThresholdBps, uint16 ltvBps, address variableDebtToken, uint16 id)",
  "event PriceSet(address indexed asset, uint256 price)",
]);

// Minimal ERC-20 surface (MockERC20 adds open mint/burn on testnet).
export const ERC20_ABI = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function transferFrom(address from, address to, uint256 amount) returns (bool)",
  "function mint(address to, uint256 amount)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
]);

// Aave V3 Pool — the subset we read (ReserveDataLegacy layout, v3.1+).
export const AAVE_POOL_ABI = parseAbi([
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
  "function getReservesList() view returns (address[])",
  "function getReserveData(address asset) view returns ((uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))",
  "function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf) returns (uint256)",
]);

export const AAVE_ORACLE_ABI = parseAbi([
  "function getAssetPrice(address asset) view returns (uint256)",
  "function getAssetsPrices(address[] assets) view returns (uint256[])",
  "function BASE_CURRENCY_UNIT() view returns (uint256)",
]);
