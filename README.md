# xsd-delta

**Constant-product arbitrage delta calculator for BankX XSD/WETH and BankX/WETH pools.**

Reads live pool reserves and computes the exact XSD token delta needed to restore the silver peg, using the equations from the BankX whitepaper.

---

## The Math

The XSD/WETH pool is a constant-product pool governed by `x · y = k`, where `x` and `y` are the total USD values of each side. The BankX whitepaper derives the following closed-form equation for the number of XSD to add or remove to restore the peg:

```
Δn₁ = n₁ · (√(p₁ / s_p) − 1)

where:
  n₁   = current XSD reserve
  p₁   = current implied XSD price  (from pool reserves + ETH/USD price)
  s_p  = silver peg target           (Chainlink XAG/USD ÷ 31.1035 grams/oz)
```

Direction:
- `Δn₁ > 0` — XSD is **above peg**. Add XSD to the pool to lower the price.
- `Δn₁ < 0` — XSD is **below peg**. Remove XSD from the pool to raise the price.

This tool makes that equation runnable against live chain state in one command.

---

## Installation

```bash
npm install -g xsd-delta
```

Or run without installing:

```bash
npx xsd-delta --mock
```

---

## Usage

### Demo mode — no RPC required

```bash
xsd-delta --mock
```

### Live mode

```bash
xsd-delta \
  --rpc       <JSON_RPC_URL>          \
  --xsd       <XSD_CONTRACT_ADDRESS>  \
  --xsd-pool  <XSDWETH_POOL_ADDRESS>  \
  --bankx-pool <BANKXWETH_POOL_ADDRESS>
```

### All options

```
--rpc          JSON-RPC endpoint (Infura, Alchemy, local node)
--xsd          XSD stablecoin contract address
--xsd-pool     XSD/WETH pool contract address
--bankx-pool   BankX/WETH pool contract address
--mock         Use built-in mock data instead of live RPC
--json         Output raw JSON (for piping into other tools)
--silver-oz    Override silver spot price in USD/oz
--help         Show this help
```

### JSON output

```bash
xsd-delta --mock --json | jq '.xsdPool.delta'
xsd-delta --mock --json | jq '.xsdPool.direction'
```

---

## Example output

```
  xsd-delta — BankX Peg Arbitrage Calculator
  ────────────────────────────────────────────────────────

  Global
    Block:        19842100
    ETH/USD:      $3,200.00
    Silver/gram:  $0.9806  (peg target)

  XSD/WETH Pool
    XSD reserve:  500,000.00 XSD
    WETH reserve: 139.2000 WETH
    Implied XSD:  $0.8909
    Target (peg): $0.9806

  Peg Delta  (Δn₁ = n₁ · (√(p₁/s_p) − 1))
    Status:       BELOW PEG  ↑ remove XSD (buy)
    Δn₁:          -23,419.44 XSD
    Target rsv:   476,580.56 XSD

  Estimated Arbitrage
    WETH flow:    -7.382100 WETH
    WETH USD val: $-23,622.72
    XSD cost:     $22,971.20
    Est. profit:  $-651.52

  BankX/WETH Pool  (reference)
    BankX reserve: 2,000,000.00 BankX
    WETH reserve:  10.0000 WETH
    Implied BankX: $0.016000

  NOTE: Estimated profit is advisory only.
  Gas costs and multi-hop slippage are not included.
  Always verify deltas on-chain before executing.
```

---

## File structure

```
src/
  math.js          Pure functions — no dependencies, fully unit-testable
  math.test.js     Node --test unit tests
  fetcher.js       ethers v6 RPC reader for both pools
  index.js         CLI entry point, argument parsing, output formatting
package.json
```

### math.js — the core module

`math.js` exports four pure functions with zero dependencies:

| Function | What it does |
|---|---|
| `ozToGramPrice(ozPrice)` | Converts silver $/oz to $/gram (÷ 31.1035) |
| `impliedXsdPrice(xsdR, wethR, ethUsd)` | Derives XSD price from pool reserves |
| `calcXsdDelta(xsdR, xsdPrice, silverGram)` | The whitepaper Δn₁ formula |
| `estimateProfit(xsdR, wethR, delta, ethUsd, silverGram)` | Constant-product WETH flow estimate |

Because `math.js` has no dependencies it can be imported directly into other tools, tested with `node --test`, or vendored into a smart contract test suite as a reference implementation.

### Running the unit tests

```bash
node --test src/math.test.js
```

---

## What the on-chain reads return

The fetcher reads three contracts:

| Contract | Function | Raw unit | Normalised to |
|---|---|---|---|
| XSD stablecoin | `eth_usd_price()` | 1e6 | decimal USD |
| XSD stablecoin | `xag_usd_price()` | 1e6 | decimal USD/oz, then ÷ 31.1035 |
| XSD/WETH pool | `getReserves()` | 1e18 (uint112) | human units |
| BankX/WETH pool | `getReserves()` | 1e18 (uint112) | human units |

All four reads happen in a single `Promise.all` call — one round-trip to the RPC.

---

## Advisory disclaimer

The estimated profit figure does not include:

- Gas costs
- Slippage on the WETH → XSD swap leg
- BankX Router execution path overhead
- Price movement between estimation and execution

Use it to identify whether an opportunity is worth investigating, not as a final P&L figure. Always simulate the full transaction before submitting.

---

## Attribution

This tool implements the arbitrage equations from the BankX Protocol whitepaper, "Arbitrage" section: https://bankx.io/whitepaper

The pool contracts being read are deployed by BankX Protocol: https://bankx.io

---

## License

MIT