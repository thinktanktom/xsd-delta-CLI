#!/usr/bin/env node
/**
 * xsd-delta CLI
 *
 * Computes the XSD delta needed to restore the BankX silver peg,
 * using the constant-product equations from the BankX whitepaper.
 *
 * Usage:
 *   xsd-delta --mock
 *   xsd-delta --rpc <URL> --xsd <ADDR> --xsd-pool <ADDR> --bankx-pool <ADDR>
 *   xsd-delta --help
 */

import chalk from "chalk";
import ora   from "ora";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import { calcXsdDelta, estimateProfit, ozToGramPrice } from "./math.js";
import { fetchPoolState, mockPoolState }               from "./fetcher.js";

// ─────────────────────────────────────────────────────────────────────────────
// Argument parsing
// ─────────────────────────────────────────────────────────────────────────────

const argv = yargs(hideBin(process.argv))
  .usage("Usage: $0 [options]")
  .option("rpc", {
    type:        "string",
    description: "JSON-RPC endpoint URL",
  })
  .option("xsd", {
    type:        "string",
    description: "XSD stablecoin contract address",
  })
  .option("xsd-pool", {
    type:        "string",
    description: "XSD/WETH pool contract address",
  })
  .option("bankx-pool", {
    type:        "string",
    description: "BankX/WETH pool contract address",
  })
  .option("mock", {
    type:        "boolean",
    default:     false,
    description: "Use built-in mock data instead of live RPC",
  })
  .option("json", {
    type:        "boolean",
    default:     false,
    description: "Output raw JSON (for piping into other tools)",
  })
  .option("silver-oz", {
    type:        "number",
    description: "Override silver spot price in USD/oz",
  })
  .check((argv) => {
    if (!argv.mock) {
      if (!argv.rpc)             throw new Error("--rpc is required (or use --mock)");
      if (!argv.xsd)             throw new Error("--xsd is required (or use --mock)");
      if (!argv["xsd-pool"])     throw new Error("--xsd-pool is required (or use --mock)");
      if (!argv["bankx-pool"])   throw new Error("--bankx-pool is required (or use --mock)");
    }
    return true;
  })
  .example("$0 --mock", "Run with mock data, no RPC needed")
  .example("$0 --mock --json | jq '.xsdPool.delta'", "Extract delta as JSON")
  .help()
  .argv;

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {

  // ── Fetch pool state ───────────────────────────────────────────────────────

  let poolState;

  if (argv.mock) {
    poolState = mockPoolState();
    if (!argv.json) {
      console.log(chalk.yellow("\n  ⚠  Mock data — not live chain state\n"));
    }
  } else {
    const spinner = ora({ text: "Fetching pool state…", color: "cyan" }).start();
    try {
      poolState = await fetchPoolState({
        rpc:          argv.rpc,
        xsdContract:  argv.xsd,
        xsdWethPool:  argv["xsd-pool"],
        bankxWethPool: argv["bankx-pool"],
      });
      spinner.succeed(`Block ${poolState.blockNumber}`);
    } catch (err) {
      spinner.fail("Failed to fetch pool state");
      console.error(chalk.red(err.message));
      process.exit(1);
    }
  }

  // ── Override silver price if provided ─────────────────────────────────────

  if (argv["silver-oz"]) {
    const gramPrice = ozToGramPrice(argv["silver-oz"]);
    poolState.xsd.silverGramUsd   = gramPrice;
    poolState.bankx.silverGramUsd = gramPrice;
  }

  // ── Calculate delta and profit estimate ───────────────────────────────────

  const { xsd: xsdSnap, bankx: bankxSnap } = poolState;

  const xsdResult = calcXsdDelta(
    xsdSnap.token0Reserve,
    xsdSnap.impliedToken0Price,
    xsdSnap.silverGramUsd,
  );

  const xsdProfit = estimateProfit(
    xsdSnap.token0Reserve,
    xsdSnap.token1Reserve,
    xsdResult.delta,
    xsdSnap.ethUsdPrice,
    xsdSnap.silverGramUsd,
  );

  // ── JSON output ────────────────────────────────────────────────────────────

  if (argv.json) {
    console.log(JSON.stringify({
      block:         poolState.blockNumber,
      ethUsdPrice:   xsdSnap.ethUsdPrice,
      silverGramUsd: xsdSnap.silverGramUsd,
      xsdPool: {
        xsdReserve:          xsdSnap.token0Reserve,
        wethReserve:         xsdSnap.token1Reserve,
        impliedPrice:        xsdSnap.impliedToken0Price,
        targetPrice:         xsdSnap.silverGramUsd,
        delta:               xsdResult.delta,
        direction:           xsdResult.direction,
        targetReserve:       xsdResult.targetReserve,
        wethOut:             xsdProfit.wethOut,
        estimatedProfitUsd:  xsdProfit.profitUsd,
      },
      bankxPool: {
        bankxReserve:  bankxSnap.token0Reserve,
        wethReserve:   bankxSnap.token1Reserve,
        impliedPrice:  bankxSnap.impliedToken0Price,
      },
    }, null, 2));
    return;
  }

  // ── Human-readable output ──────────────────────────────────────────────────

  const fmt = (n, dp = 4) =>
    n.toLocaleString("en-US", {
      minimumFractionDigits: dp,
      maximumFractionDigits: dp,
    });

  const dirColour = {
    above_peg: chalk.red,
    below_peg: chalk.yellow,
    at_peg:    chalk.green,
  };

  const dirLabel = {
    above_peg: "ABOVE PEG  ↓ add XSD (sell into pool)",
    below_peg: "BELOW PEG  ↑ remove XSD (buy from pool)",
    at_peg:    "AT PEG     ✓",
  };

  const col = dirColour[xsdResult.direction];

  console.log();
  console.log(chalk.bold.cyan("  xsd-delta — BankX Peg Arbitrage Calculator"));
  console.log(chalk.dim("  " + "─".repeat(58)));

  console.log();
  console.log(chalk.bold("  Global"));
  console.log(`    Block:        ${chalk.white(poolState.blockNumber || "mock")}`);
  console.log(`    ETH/USD:      ${chalk.white("$" + fmt(xsdSnap.ethUsdPrice, 2))}`);
  console.log(`    Silver/gram:  ${chalk.white("$" + fmt(xsdSnap.silverGramUsd, 4))}  (peg target)`);

  console.log();
  console.log(chalk.bold(`  ${xsdSnap.poolName}`));
  console.log(`    XSD reserve:  ${chalk.white(fmt(xsdSnap.token0Reserve, 2))} XSD`);
  console.log(`    WETH reserve: ${chalk.white(fmt(xsdSnap.token1Reserve, 4))} WETH`);
  console.log(`    Implied XSD:  ${chalk.white("$" + fmt(xsdSnap.impliedToken0Price, 4))}`);
  console.log(`    Target (peg): ${chalk.white("$" + fmt(xsdSnap.silverGramUsd, 4))}`);

  console.log();
  console.log(chalk.bold("  Peg Delta  (Δn₁ = n₁ · (√(p₁/s_p) − 1))"));
  console.log(`    Status:       ${col(dirLabel[xsdResult.direction])}`);
  console.log(`    Δn₁:          ${col(fmt(xsdResult.delta, 2) + " XSD")}`);
  console.log(`    Target rsv:   ${chalk.white(fmt(xsdResult.targetReserve, 2))} XSD`);

  console.log();
  console.log(chalk.bold("  Estimated Arbitrage"));

  const profitCol = xsdProfit.profitUsd >= 0 ? chalk.green : chalk.red;

  console.log(`    WETH flow:    ${chalk.white(fmt(xsdProfit.wethOut, 6) + " WETH")}`);
  console.log(`    WETH USD val: ${chalk.white("$" + fmt(xsdProfit.usdValue, 2))}`);
  console.log(`    XSD cost:     ${chalk.white("$" + fmt(xsdProfit.xsdUsdValue, 2))}`);
  console.log(`    Est. profit:  ${profitCol("$" + fmt(xsdProfit.profitUsd, 2))}`);

  console.log();
  console.log(chalk.bold(`  ${bankxSnap.poolName}  (reference)`));
  console.log(`    BankX reserve: ${chalk.white(fmt(bankxSnap.token0Reserve, 2))} BankX`);
  console.log(`    WETH reserve:  ${chalk.white(fmt(bankxSnap.token1Reserve, 4))} WETH`);
  console.log(`    Implied BankX: ${chalk.white("$" + fmt(bankxSnap.impliedToken0Price, 6))}`);

  console.log();
  console.log(chalk.dim("  NOTE: Estimated profit is advisory only."));
  console.log(chalk.dim("  Gas costs and multi-hop slippage are not included."));
  console.log(chalk.dim("  Always verify deltas on-chain before executing."));
  console.log();
}

main().catch((err) => {
  console.error(chalk.red("\n  Error: " + err.message));
  process.exit(1);
});