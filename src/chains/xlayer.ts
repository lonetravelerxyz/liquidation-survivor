import { defineChain } from "viem";

export const xlayer = defineChain({
  id: 196,
  name: "X Layer",
  nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.xlayer.tech"] } },
  blockExplorers: { default: { name: "OKX Explorer", url: "https://web3.okx.com/explorer/x-layer" } },
});

export const xlayerTestnet = defineChain({
  id: 1952,
  name: "X Layer Testnet",
  nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
  rpcUrls: { default: { http: ["https://testrpc.xlayer.tech"] } },
  blockExplorers: { default: { name: "OKX Explorer", url: "https://web3.okx.com/explorer/x-layer-testnet" } },
  testnet: true,
});

export interface Reserve {
  symbol: string;
  address: `0x${string}`;
  decimals: number;
  aToken: `0x${string}`;
  vToken: `0x${string}`;
  /** true for assets a user would hold as a repayment buffer (stablecoins) */
  stable: boolean;
}

// Aave V3 X Layer reserves — verified 2026-08-19 (docs/references.md). Note Aave's "USDT" is USD₮0.
export const MAINNET_RESERVES: readonly Reserve[] = [
  {
    symbol: "USDT",
    address: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736",
    decimals: 6,
    aToken: "0xF356ae412dB5df43BD3a10746f7ad4e1C4De4297",
    vToken: "0x04837866D0cb0cd2D8F60fBCa83B4a24b3a7c8ac",
    stable: true,
  },
  {
    symbol: "USDG",
    address: "0x4ae46a509F6b1D9056937BA4500cb143933D2dc8",
    decimals: 6,
    aToken: "0x228765a3C18065C923F23a0CCb6c7cEFB3eA2223",
    vToken: "0xE6FC328D4DECB2Ae00E711743C04612ec963be46",
    stable: true,
  },
  {
    symbol: "xBTC",
    address: "0xb7C00000bcDEeF966b20B3D884B98E64d2b06b4f",
    decimals: 8,
    aToken: "0xF5F9d4e9e2AFe7E0b193d291Befb41d61930464e",
    vToken: "0x5F874396f28dfdBd6bA2be80F52FD013Ce388C75",
    stable: false,
  },
  {
    symbol: "WOKB",
    address: "0xe538905cf8410324e03A5A23C1c177a474D59b2b",
    decimals: 18,
    aToken: "0x3ea3A4038FbA5757A9A68de920b44698d7326A59",
    vToken: "0xb20752a1D7D16E54cBaad5137ba6C0a087752803",
    stable: false,
  },
  {
    symbol: "xETH",
    address: "0xE7B000003A45145decf8a28FC755aD5eC5EA025A",
    decimals: 18,
    aToken: "0xe6639ba6c1d79Be6d4c776E4c17504538d1719cD",
    vToken: "0xB756Fc7065369602f2cCb8356283E8b997fDfe2a",
    stable: false,
  },
  {
    symbol: "xSOL",
    address: "0x505000008DE8748DBd4422ff4687a4FC9bEba15b",
    decimals: 9,
    aToken: "0x523dCe1b164327818fc5B41278fAe41f6B5753FE",
    vToken: "0x4aF568Cb78Ade0e45E42f9B6d3deC0ff81E788af",
    stable: false,
  },
  {
    symbol: "xBETH",
    address: "0xAFeab3B85B6A56cF5F02317F0f7A23340eb983D7",
    decimals: 18,
    aToken: "0xe9e78053f1Ef084f8cD01dBE8ccE95c6b0944d32",
    vToken: "0xe98AB0041B3BC09981D75A46aa78CC5e647a3906",
    stable: false,
  },
  {
    symbol: "xOKSOL",
    address: "0x14a686103854DAB7b8801E31979CAA595835B25d",
    decimals: 9,
    aToken: "0x38811564090aAb7bB455c5b771e26201a3535a01",
    vToken: "0x3bEB61760eC29C2031843811dd5D51Bcbdb73B5e",
    stable: false,
  },
  {
    symbol: "GHO",
    address: "0xDe6539018B095353A40753Dc54C91C68c9487D4E",
    decimals: 18,
    aToken: "0x77188335A21f4C409d2CfeDe3195A7B5f28651b0",
    vToken: "0x6a82EFFC620ec646429e8A1aE0E5DcC6C6ba30aA",
    stable: true,
  },
];

export const MAINNET_ORACLE: `0x${string}` = "0x91FC11136d5615575a0fC5981Ab5C0C54418E2C6";

export const explorerTx = (chainId: number, hash: string) =>
  `${chainId === 196 ? xlayer.blockExplorers.default.url : xlayerTestnet.blockExplorers.default.url}/tx/${hash}`;
export const explorerAddress = (chainId: number, a: string) =>
  `${chainId === 196 ? xlayer.blockExplorers.default.url : xlayerTestnet.blockExplorers.default.url}/address/${a}`;
