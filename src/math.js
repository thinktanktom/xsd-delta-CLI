/**
 * xsd-delta / math.js
 *
 * Pure math for BankX constant-product arbitrage delta calculation.
 * No ethers, no RPC — fully unit-testable in isolation.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SOURCE EQUATIONS  (BankX Whitepaper, "Arbitrage" section)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The XSD/WETH pool is a constant-product pool governed by:
 *
 *   x · y = k
 *
 * where x = total USD value of XSD in the pool  = n₁ · p₁
 *       y = total USD value of ETH in the pool  = n₂ · p₂
 *
 * The target XSD reserve at peg price s_p:
 *
 *   tar_n₁ = n₁ · √(p₁ / s_p)
 *
 * The delta — tokens to add or remove to reach the peg:
 *
 *   Δn₁ = tar_n₁ − n₁  =  n₁ · (√(p₁ / s_p) − 1)
 *
 * Direction:
 *   Δn₁ > 0  →  p₁ > s_p  (above peg)  →  add XSD to pool to lower price
 *   Δn₁ < 0  →  p₁ < s_p  (below peg)  →  remove XSD from pool to raise price
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PRECISION NOTE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * All on-chain values use integer arithmetic. This module uses JavaScript's
 * native 64-bit floats which give ~15 significant digits — sufficient for
 * display and advisory purposes. Do not feed these values directly into a
 * transaction without re-running the calculation in integer arithmetic via
 * a smart contract (e.g. the BankX Router).
 *
 * Reserves are normalised from 1e18 wei → human units before all calculations.
 * Prices are normalised from 1e6 fixed-point → decimal.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Silver price helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert a silver spot price (USD per troy ounce) to USD per gram.
 *
 * 1 troy ounce = 31.1035 grams
 *
 * The BankX XSD stablecoin is pegged to 1 gram of silver, not 1 troy ounce.
 * The Chainlink XAG/USD feed returns per-ounce. Always convert before comparing
 * to the XSD price.
 *
 * @param {number} ozPrice  Silver spot price in USD per troy ounce.
 * @returns {number}        Silver price in USD per gram.
 */
export function ozToGramPrice(ozPrice) {
  if (ozPrice <= 0) throw new Error("ozPrice must be positive");
  return ozPrice / 31.1035;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pool price from reserves
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Derive the implied XSD price from pool reserves.
 *
 * In a constant-product pool with no fees, the marginal price of token0
 * (XSD) in terms of token1 (WETH) is reserve1 / reserve0. Multiplying by
 * the ETH/USD price converts to USD.
 *
 * @param {number} xsdReserve   XSD reserve in human units (1e18 normalised).
 * @param {number} wethReserve  WETH reserve in human units.
 * @param {number} ethUsdPrice  ETH price in USD (decimal, not 1e6).
 * @returns {number}            Implied XSD price in USD.
 */
export function impliedXsdPrice(xsdReserve, wethReserve, ethUsdPrice) {
  if (xsdReserve <= 0)  throw new Error("XSD reserve must be positive");
  if (wethReserve <= 0) throw new Error("WETH reserve must be positive");
  if (ethUsdPrice <= 0) throw new Error("ETH/USD price must be positive");
  return (wethReserve / xsdReserve) * ethUsdPrice;
}

/**
 * Derive the implied BankX price from pool reserves.
 *
 * @param {number} bankxReserve  BankX reserve in human units.
 * @param {number} wethReserve   WETH reserve in human units.
 * @param {number} ethUsdPrice   ETH price in USD (decimal).
 * @returns {number}             Implied BankX price in USD.
 */
export function impliedBankXPrice(bankxReserve, wethReserve, ethUsdPrice) {
  if (bankxReserve <= 0) throw new Error("BankX reserve must be positive");
  if (wethReserve <= 0)  throw new Error("WETH reserve must be positive");
  if (ethUsdPrice <= 0)  throw new Error("ETH/USD price must be positive");
  return (wethReserve / bankxReserve) * ethUsdPrice;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core delta calculation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate the XSD delta required to bring the XSD/WETH pool to peg.
 *
 * Implements the BankX whitepaper formula:
 *
 *   Δn₁ = n₁ · (√(p₁ / s_p) − 1)
 *
 * @param {number} xsdReserve    Current XSD reserve in the pool, human units.
 * @param {number} xsdPrice      Current implied XSD price in USD.
 * @param {number} silverGramUsd Silver peg target in USD per gram.
 * @returns {{
 *   delta:         number,  Δn₁ — positive = add XSD (above peg), negative = remove XSD (below peg)
 *   direction:     string,  "above_peg" | "below_peg" | "at_peg"
 *   targetReserve: number,  tar_n₁ — the ideal XSD reserve at peg
 *   targetPrice:   number,  silverGramUsd (echoed for display)
 * }}
 */
export function calcXsdDelta(xsdReserve, xsdPrice, silverGramUsd) {
  if (xsdReserve <= 0)    throw new Error("xsdReserve must be positive");
  if (xsdPrice <= 0)      throw new Error("xsdPrice must be positive");
  if (silverGramUsd <= 0) throw new Error("silverGramUsd must be positive");

  // tar_n₁ = n₁ · √(p₁ / s_p)
  const targetReserve = xsdReserve * Math.sqrt(xsdPrice / silverGramUsd);

  // Δn₁ = tar_n₁ − n₁
  const delta = targetReserve - xsdReserve;

  // Direction:
  //   delta > 0  →  p₁ > s_p  (XSD above peg)  →  add XSD to lower the price
  //   delta < 0  →  p₁ < s_p  (XSD below peg)  →  remove XSD to raise the price
  //
  // Common inversion mistake: confusing the action with the direction.
  // "Above peg" means price is too high, so we flood the pool with XSD.
  // "Below peg" means price is too low, so we drain XSD from the pool.
  const EPSILON = 1e-8;
  let direction;
  if (Math.abs(delta) < EPSILON * xsdReserve) {
    direction = "at_peg";
  } else if (delta > 0) {
    direction = "above_peg";
  } else {
    direction = "below_peg";
  }

  return { delta, direction, targetReserve, targetPrice: silverGramUsd };
}

// ─────────────────────────────────────────────────────────────────────────────
// Profit estimation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Estimate the WETH flow and USD profit from closing an XSD peg deviation.
 *
 * Uses the constant-product formula to determine the WETH received or spent
 * when swapping |Δn₁| XSD, then computes the net gain versus the peg price.
 *
 * Sign convention on wethOut:
 *   positive  →  you receive WETH  (above peg — you sell XSD into the pool)
 *   negative  →  you spend WETH   (below peg — you buy XSD from the pool)
 *
 * This is an advisory estimate. Real profit depends on gas costs, slippage
 * in subsequent swaps, and the BankX Router's execution path.
 *
 * @param {number} xsdReserve    Current XSD reserve, human units.
 * @param {number} wethReserve   Current WETH reserve, human units.
 * @param {number} delta         Δn₁ from calcXsdDelta (signed).
 * @param {number} ethUsdPrice   ETH/USD price (decimal).
 * @param {number} silverGramUsd Target peg price in USD per gram.
 * @returns {{
 *   wethOut:     number,  WETH received (+) or spent (-)
 *   usdValue:    number,  wethOut × ethUsdPrice
 *   xsdUsdValue: number,  |delta| × silverGramUsd  (value of XSD at peg)
 *   profitUsd:   number,  usdValue − xsdUsdValue
 * }}
 */
export function estimateProfit(
  xsdReserve,
  wethReserve,
  delta,
  ethUsdPrice,
  silverGramUsd
) {
  if (xsdReserve <= 0)    throw new Error("xsdReserve must be positive");
  if (wethReserve <= 0)   throw new Error("wethReserve must be positive");
  if (ethUsdPrice <= 0)   throw new Error("ethUsdPrice must be positive");
  if (silverGramUsd <= 0) throw new Error("silverGramUsd must be positive");

  if (delta === 0) {
    return { wethOut: 0, usdValue: 0, xsdUsdValue: 0, profitUsd: 0 };
  }

  // Apply delta to the constant-product invariant:
  //   k = xsdReserve * wethReserve
  //   newXsdReserve  = xsdReserve + delta
  //   newWethReserve = k / newXsdReserve
  //   wethOut        = wethReserve - newWethReserve
  //
  // When delta > 0 (above peg, adding XSD):
  //   newXsdReserve increases → newWethReserve decreases → wethOut > 0 (receive WETH)
  //
  // When delta < 0 (below peg, removing XSD):
  //   newXsdReserve decreases → newWethReserve increases → wethOut < 0 (spend WETH)
  const k              = xsdReserve * wethReserve;
  const newXsdReserve  = xsdReserve + delta;
  const newWethReserve = k / newXsdReserve;
  const wethOut        = wethReserve - newWethReserve;

  const usdValue    = wethOut * ethUsdPrice;
  const xsdUsdValue = Math.abs(delta) * silverGramUsd;
  const profitUsd   = usdValue - xsdUsdValue;

  return { wethOut, usdValue, xsdUsdValue, profitUsd };
}