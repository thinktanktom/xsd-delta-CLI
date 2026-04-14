/**
 * xsd-delta / fetcher.js
 *
 * Reads live pool state from the BankX XSD/WETH and BankX/WETH pools
 * using ethers v6. Returns all values normalised to human-readable units
 * so math.js never has to deal with raw on-chain integers.
 *
 * Normalisation rules:
 *   uint112 reserve (1e18 wei)  → divide by 1e18 → human token units
 *   eth_usd_price() (1e6)       → divide by 1e6  → decimal USD
 *   xag_usd_price() (1e6)       → divide by 1e6  → decimal USD/oz
 *                                 then ÷ 31.1035  → decimal USD/gram
 */

import { ethers } from "ethers";

// ─────────────────────────────────────────────────────────────────────────────
// Minimal ABIs — only the functions we actually call
// ─────────────────────────────────────────────────────────────────────────────

const POOL_ABI = [
  "function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
];

// Both price views live on the XSD stablecoin contract.
// eth_usd_price() and xag_usd_price() return 1e6 fixed-point.
const XSD_ABI = [
  "function eth_usd_price() external view returns (uint256)",
  "function xag_usd_price() external view returns (uint256)",
];

// ─────────────────────────────────────────────────────────────────────────────
// Live fetch
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch live on-chain state for both BankX pools in a single RPC round-trip.
 *
 * @param {Object} opts
 * @param {string} opts.rpc            JSON-RPC endpoint URL.
 * @param {string} opts.xsdContract    XSD stablecoin contract address.
 * @param {string} opts.xsdWethPool    XSD/WETH pool contract address.
 * @param {string} opts.bankxWethPool  BankX/WETH pool contract address.
 * @returns {Promise<PoolState>}
 */
export async function fetchPoolState(opts) {
  const provider = new ethers.JsonRpcProvider(opts.rpc);

  const xsdPool   = new ethers.Contract(opts.xsdWethPool,   POOL_ABI, provider);
  const bankxPool = new ethers.Contract(opts.bankxWethPool, POOL_ABI, provider);
  const xsd       = new ethers.Contract(opts.xsdContract,   XSD_ABI,  provider);

  // All reads in a single Promise.all — one round-trip to the node.
  const [
    xsdReserves,
    bankxReserves,
    ethUsdRaw,
    xagUsdRaw,
    blockNumber,
  ] = await Promise.all([
    xsdPool.getReserves(),
    bankxPool.getReserves(),
    xsd.eth_usd_price(),
    xsd.xag_usd_price(),
    provider.getBlockNumber(),
  ]);

  // ── Normalise prices ──────────────────────────────────────────────────────
  const ethUsdPrice   = Number(ethUsdRaw)  / 1e6;
  const silverOzUsd   = Number(xagUsdRaw)  / 1e6;
  const silverGramUsd = silverOzUsd / 31.1035;

  // ── Normalise reserves ────────────────────────────────────────────────────
  // XSD/WETH pool:    reserve0 = XSD (1e18),   reserve1 = WETH (1e18)
  // BankX/WETH pool:  reserve0 = BankX (1e18), reserve1 = WETH (1e18)
  const xsdReserve    = Number(xsdReserves[0])   / 1e18;
  const wethXsdPool   = Number(xsdReserves[1])   / 1e18;
  const bankxReserve  = Number(bankxReserves[0]) / 1e18;
  const wethBankxPool = Number(bankxReserves[1]) / 1e18;

  // ── Implied prices ────────────────────────────────────────────────────────
  const impliedXsdPrice   = xsdReserve   > 0 ? (wethXsdPool   / xsdReserve)   * ethUsdPrice : 0;
  const impliedBankxPrice = bankxReserve > 0 ? (wethBankxPool / bankxReserve) * ethUsdPrice : 0;

  return buildState({
    xsdReserve, wethXsdPool,
    bankxReserve, wethBankxPool,
    ethUsdPrice, silverGramUsd,
    impliedXsdPrice, impliedBankxPrice,
    blockNumber,
    mock: false,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Mock state — for demos and CI without an RPC
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns a hardcoded snapshot representing "XSD slightly below peg".
 * Use this with --mock to run the CLI or tests without a live node.
 *
 * Mock parameters:
 *   ETH:    $3,200
 *   Silver: $30.50/oz → $0.9806/gram
 *   XSD pool: 500,000 XSD / 139.2 WETH → implied price $0.8909 (below $0.9806 peg)
 */
export function mockPoolState() {
  const ethUsdPrice   = 3_200;
  const silverOzUsd   = 30.50;
  const silverGramUsd = silverOzUsd / 31.1035;    // ~$0.9806/gram

  const xsdReserve    = 500_000;
  const wethXsdPool   = 139.2;
  const bankxReserve  = 2_000_000;
  const wethBankxPool = 10;

  const impliedXsdPrice   = (wethXsdPool   / xsdReserve)   * ethUsdPrice;
  const impliedBankxPrice = (wethBankxPool / bankxReserve) * ethUsdPrice;

  return buildState({
    xsdReserve, wethXsdPool,
    bankxReserve, wethBankxPool,
    ethUsdPrice, silverGramUsd,
    impliedXsdPrice, impliedBankxPrice,
    blockNumber: 0,
    mock: true,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal shape builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} PoolSnapshot
 * @property {string}  poolName
 * @property {number}  token0Reserve       XSD or BankX, human units
 * @property {number}  token1Reserve       WETH, human units
 * @property {string}  token0Symbol        "XSD" or "BankX"
 * @property {number}  impliedToken0Price  USD price of token0 from pool
 * @property {number}  ethUsdPrice
 * @property {number}  silverGramUsd       Silver peg target
 * @property {number}  blockNumber
 *
 * @typedef {Object} PoolState
 * @property {PoolSnapshot} xsd
 * @property {PoolSnapshot} bankx
 * @property {number}       blockNumber
 */

function buildState({
  xsdReserve, wethXsdPool,
  bankxReserve, wethBankxPool,
  ethUsdPrice, silverGramUsd,
  impliedXsdPrice, impliedBankxPrice,
  blockNumber, mock,
}) {
  const suffix = mock ? "  [MOCK]" : "";

  return {
    xsd: {
      poolName:           `XSD/WETH${suffix}`,
      token0Reserve:      xsdReserve,
      token1Reserve:      wethXsdPool,
      token0Symbol:       "XSD",
      impliedToken0Price: impliedXsdPrice,
      ethUsdPrice,
      silverGramUsd,
      blockNumber,
    },
    bankx: {
      poolName:           `BankX/WETH${suffix}`,
      token0Reserve:      bankxReserve,
      token1Reserve:      wethBankxPool,
      token0Symbol:       "BankX",
      impliedToken0Price: impliedBankxPrice,
      ethUsdPrice,
      silverGramUsd,
      blockNumber,
    },
    blockNumber,
  };
}