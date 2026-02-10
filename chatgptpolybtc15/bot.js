import fs from "fs";
import path from "path";
import axios from "axios";
import cron from "node-cron";
import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config();

const CONFIG = {
  rpcUrl: process.env.RPC_URL,
  privateKey: process.env.PRIVATE_KEY,
  liveMode: process.env.LIVE_MODE === "true",
  maxBetPercent: Number(process.env.MAX_BET_PERCENT ?? 0.05),
  minUsdcBalance: Number(process.env.MIN_USDC_BALANCE ?? 10),
  chainlinkFeed: process.env.CHAINLINK_BTC_USD_FEED ?? "0xc907E116054Ad103354f2D350FD2514433D57F6f",
  usdcAddress: process.env.USDC_ADDRESS ?? "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  cachePath: process.env.PRICE_CACHE_PATH ?? path.join(process.cwd(), "price_cache.json"),
  tradeLogPath: process.env.TRADE_LOG_PATH ?? path.join(process.cwd(), "trade_log.jsonl"),
  polymarketApiBase: process.env.POLYMARKET_API_BASE ?? "https://gamma-api.polymarket.com",
  polymarketClobBase: process.env.POLYMARKET_CLOB_BASE ?? "https://clob.polymarket.com",
  polymarketApiKey: process.env.POLYMARKET_API_KEY ?? "",
  polymarketApiSecret: process.env.POLYMARKET_API_SECRET ?? "",
  slippageBps: Number(process.env.SLIPPAGE_BPS ?? 50),
};

if (!CONFIG.rpcUrl || !CONFIG.privateKey) {
  throw new Error("Missing RPC_URL or PRIVATE_KEY in environment.");
}

const provider = new ethers.JsonRpcProvider(CONFIG.rpcUrl);
const wallet = new ethers.Wallet(CONFIG.privateKey, provider);

const AGGREGATOR_ABI = [
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
  "function decimals() view returns (uint8)",
];

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

const priceHistorySchema = { version: 1, entries: [] };

const logLine = (message, data = {}) => {
  const line = {
    timestamp: new Date().toISOString(),
    message,
    ...data,
  };
  fs.appendFileSync(CONFIG.tradeLogPath, `${JSON.stringify(line)}\n`, "utf8");
  console.log(line);
};

const loadPriceHistory = () => {
  if (!fs.existsSync(CONFIG.cachePath)) {
    return { ...priceHistorySchema };
  }
  const raw = fs.readFileSync(CONFIG.cachePath, "utf8");
  try {
    const parsed = JSON.parse(raw);
    return {
      version: parsed.version ?? 1,
      entries: Array.isArray(parsed.entries) ? parsed.entries : [],
    };
  } catch (error) {
    logLine("Failed to parse price cache, resetting.", { error: error.message });
    return { ...priceHistorySchema };
  }
};

const savePriceHistory = (history) => {
  fs.writeFileSync(CONFIG.cachePath, JSON.stringify(history, null, 2));
};

const storePricePoint = (history, price) => {
  const entry = { timestamp: Date.now(), price };
  history.entries.push(entry);
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  history.entries = history.entries.filter((item) => item.timestamp >= cutoff);
  savePriceHistory(history);
  return entry;
};

const getPriceFrom15MinAgo = (history) => {
  const target = Date.now() - 15 * 60 * 1000;
  const candidates = history.entries
    .filter((entry) => entry.timestamp <= target)
    .sort((a, b) => b.timestamp - a.timestamp);
  return candidates[0] ?? null;
};

const fetchChainlinkPrice = async () => {
  const feed = new ethers.Contract(CONFIG.chainlinkFeed, AGGREGATOR_ABI, provider);
  const decimals = await feed.decimals();
  const [, answer] = await feed.latestRoundData();
  const price = Number(ethers.formatUnits(answer, decimals));
  return price;
};

const getUsdcBalance = async () => {
  const usdc = new ethers.Contract(CONFIG.usdcAddress, ERC20_ABI, provider);
  const decimals = await usdc.decimals();
  const balanceRaw = await usdc.balanceOf(wallet.address);
  const balance = Number(ethers.formatUnits(balanceRaw, decimals));
  return { balance, decimals, balanceRaw };
};

const fetchActiveBtcMarkets = async () => {
  const url = `${CONFIG.polymarketApiBase}/markets`;
  const response = await axios.get(url, {
    params: {
      active: true,
      limit: 200,
      tag: "BTC",
    },
    timeout: 10000,
  });
  return Array.isArray(response.data) ? response.data : response.data?.markets ?? [];
};

const parseMarketStartTime = (market) => {
  const raw = market.start_time ?? market.startTime ?? market.start_date ?? market.startDate;
  if (!raw) {
    return null;
  }
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
};

const selectMarketForNextInterval = (markets) => {
  const now = new Date();
  const nextInterval = new Date(now);
  nextInterval.setUTCSeconds(0, 0);
  const minutes = nextInterval.getUTCMinutes();
  const remainder = minutes % 15;
  nextInterval.setUTCMinutes(minutes + (15 - remainder));

  const windowStart = nextInterval.getTime() - 60 * 1000;
  const windowEnd = nextInterval.getTime() + 60 * 1000;

  const candidates = markets
    .map((market) => ({
      market,
      startTime: parseMarketStartTime(market),
    }))
    .filter(({ startTime }) => startTime && startTime.getTime() >= windowStart && startTime.getTime() <= windowEnd);

  return candidates[0]?.market ?? null;
};

const computeSignal = (currentPrice, pastEntry) => {
  if (!pastEntry) {
    return null;
  }
  return currentPrice > pastEntry.price ? "UP" : "DOWN";
};

const buildOrderPayload = ({ market, signal, size }) => {
  const outcomeName = signal === "UP" ? "Yes" : "No";
  return {
    market_id: market.id ?? market.market_id ?? market.marketId,
    outcome: outcomeName,
    side: "buy",
    size,
    price: signal === "UP" ? 1 : 1,
    expiration: Math.floor(Date.now() / 1000) + 60,
  };
};

const signOrderPayload = async (payload) => {
  const message = JSON.stringify(payload);
  const signature = await wallet.signMessage(message);
  return signature;
};

const placeOrder = async ({ market, signal, size }) => {
  const payload = buildOrderPayload({ market, signal, size });

  if (!CONFIG.liveMode) {
    logLine("Dry run - skipping order placement.", { payload });
    return { status: "dry-run", payload };
  }

  if (!CONFIG.polymarketApiKey || !CONFIG.polymarketApiSecret) {
    throw new Error("Missing POLYMARKET_API_KEY or POLYMARKET_API_SECRET for live trading.");
  }

  const signature = await signOrderPayload(payload);

  const response = await axios.post(`${CONFIG.polymarketClobBase}/orders`, payload, {
    headers: {
      "x-api-key": CONFIG.polymarketApiKey,
      "x-api-secret": CONFIG.polymarketApiSecret,
      "x-wallet-address": wallet.address,
      "x-wallet-signature": signature,
    },
    timeout: 10000,
  });

  return response.data;
};

const runTradingCycle = async () => {
  const history = loadPriceHistory();
  const currentPrice = await fetchChainlinkPrice();
  const pastEntry = getPriceFrom15MinAgo(history);
  storePricePoint(history, currentPrice);

  if (!pastEntry) {
    logLine("Insufficient price history to compute signal.", { currentPrice });
    return;
  }

  const signal = computeSignal(currentPrice, pastEntry);
  if (!signal) {
    logLine("Signal unavailable.", { currentPrice });
    return;
  }

  const { balance } = await getUsdcBalance();
  if (balance < CONFIG.minUsdcBalance) {
    logLine("Balance below minimum, skipping trade.", { balance });
    return;
  }

  const allocation = Math.max(balance * CONFIG.maxBetPercent, 0);
  if (allocation <= 0) {
    logLine("Allocation computed as 0, skipping.", { balance });
    return;
  }

  const markets = await fetchActiveBtcMarkets();
  const market = selectMarketForNextInterval(markets);
  if (!market) {
    logLine("No matching market found for next interval.", { signal });
    return;
  }

  logLine("Placing order.", {
    marketId: market.id ?? market.market_id ?? market.marketId,
    signal,
    allocation,
    currentPrice,
    pastPrice: pastEntry.price,
  });

  const orderResult = await placeOrder({ market, signal, size: allocation });

  logLine("Order result.", {
    signal,
    marketId: market.id ?? market.market_id ?? market.marketId,
    orderResult,
  });
};

let lastIntervalStart = null;

const shouldRunForNow = () => {
  const now = new Date();
  const minutes = now.getUTCMinutes();
  const seconds = now.getUTCSeconds();

  if (minutes % 15 !== 14) {
    return { shouldRun: false };
  }

  if (seconds > 5) {
    return { shouldRun: false };
  }

  const intervalStart = new Date(now);
  intervalStart.setUTCSeconds(0, 0);
  intervalStart.setUTCMinutes(minutes + 1);

  const intervalKey = intervalStart.toISOString();
  if (lastIntervalStart === intervalKey) {
    return { shouldRun: false };
  }

  lastIntervalStart = intervalKey;
  return { shouldRun: true, intervalStart };
};

const startScheduler = () => {
  cron.schedule("* * * * *", async () => {
    const { shouldRun } = shouldRunForNow();
    if (!shouldRun) {
      return;
    }

    try {
      await runTradingCycle();
    } catch (error) {
      logLine("Trading cycle failed.", { error: error.message });
    }
  });

  logLine("Scheduler started.", {
    liveMode: CONFIG.liveMode,
    wallet: wallet.address,
  });
};

startScheduler();
