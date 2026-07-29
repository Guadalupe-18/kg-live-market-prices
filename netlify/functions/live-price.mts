import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

// Cache window: keeps this endpoint inside Alpha Vantage's free-tier
// allowance (25 requests/day) even with the current 4 tracked symbols.
const TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

type SymbolKind = "metal" | "equity";

const SYMBOLS: Record<string, { kind: SymbolKind; av: string }> = {
  XAU: { kind: "metal", av: "XAU" },
  XAG: { kind: "metal", av: "XAG" },
  SPY: { kind: "equity", av: "SPY" },
  QQQ: { kind: "equity", av: "QQQ" },
};

const CORS_HEADERS = {
  "content-type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "no-store",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: CORS_HEADERS });
}

async function fetchFromAlphaVantage(symbol: string, apiKey: string) {
  const def = SYMBOLS[symbol];

  if (def.kind === "metal") {
    const url = `https://www.alphavantage.co/query?function=GOLD_SILVER_SPOT&symbol=${def.av}&apikey=${apiKey}`;
    const res = await fetch(url);
    const data = await res.json();
    const price = data?.price;
    if (!price) {
      throw new Error(data?.Note || data?.Information || data?.["Error Message"] || "Alpha Vantage returned no spot price data");
    }
    return {
      price: parseFloat(price),
      sourceTimestamp: data.timestamp,
    };
  }

  const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${def.av}&apikey=${apiKey}`;
  const res = await fetch(url);
  const data = await res.json();
  const quote = data?.["Global Quote"];
  const price = quote?.["05. price"];
  if (!price) {
    throw new Error(data?.Note || data?.Information || data?.["Error Message"] || "Alpha Vantage returned no quote data");
  }
  return {
    price: parseFloat(price),
    sourceTimestamp: quote["07. latest trading day"],
  };
}

export default async (req: Request, _context: Context) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const url = new URL(req.url);
  const symbol = (url.searchParams.get("symbol") || "").toUpperCase();

  if (!SYMBOLS[symbol]) {
    return json({ error: "unknown or missing symbol. Use one of: XAU, XAG, SPY, QQQ" }, 400);
  }

  const store = getStore("live-prices");
  const cached = await store.get(symbol, { type: "json" });
  const now = Date.now();

  if (cached && now - cached.fetchedAt < TTL_MS) {
    return json({ ...cached, cacheHit: true });
  }

  const apiKey = Netlify.env.get("ALPHAVANTAGE_API_KEY");

  if (!apiKey) {
    if (cached) {
      return json({ ...cached, cacheHit: true, stale: true, warning: "server has no API key configured yet; serving last known value" });
    }
    return json({ error: "server not configured: missing ALPHAVANTAGE_API_KEY environment variable" }, 503);
  }

  try {
    const fresh = await fetchFromAlphaVantage(symbol, apiKey);
    const payload = {
      symbol,
      price: fresh.price,
      sourceTimestamp: fresh.sourceTimestamp,
      fetchedAt: now,
    };
    await store.setJSON(symbol, payload);
    return json({ ...payload, cacheHit: false });
  } catch (err) {
    if (cached) {
      return json({ ...cached, cacheHit: true, stale: true, warning: String(err instanceof Error ? err.message : err) });
    }
    return json({ error: String(err instanceof Error ? err.message : err) }, 502);
  }
};

export const config: Config = {
  path: "/live-price",
};
