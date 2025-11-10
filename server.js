// server.js - FINAL 100% WORKING VERSION - NOV 2025
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const Redis = require('ioredis');
const rateLimit = require('axios-rate-limit');
const { count } = require('console');

const PORT = process.env.PORT || 3000;
const REFRESH_INTERVAL = 15000;

const CACHE_TTL = 30;
const MAX_REQUESTS_PER_MINUTE = 280;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const redis = new Redis('redis://localhost:6379');  // Your Docker Redis

const axiosLimited = rateLimit(axios.create(), {
  maxRequests: MAX_REQUESTS_PER_MINUTE,
  perMilliseconds: 60000,
});

let cachedTokens = [];
const CACHE_KEY = 'meme_tokens_v1';

async function fetchWithRetry(url, retries = 5) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await axiosLimited.get(url);
      return res.data;
    } catch (err) {
      if (err.response?.status === 429) {
        const delay = Math.pow(2, i) * 1000;
        console.log(`Rate limited, waiting ${delay/1000}s...`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }
  throw new Error('Failed after retries');
}

async function fetchDexScreener() {
  const url = 'https://api.dexscreener.com/latest/dex/search?q=USBC/SOL';  // THIS IS THE ONE
  console.log('Fetching DexScreener...');
  let data;
  
  try {
    data = await fetchWithRetry(url);
    // console.log(data);
  } catch (err) {
    console.log('DexScreener failed');
    return [];
  }

  if (!data.pairs) return [];

  const tokens = [];
  const seen = new Set();
  let count = 0;
  //console.log(typeof(data.pairs));
  //console.log(data.pairs[0])
  
  for (const pair of data.pairs) {

    if (pair.quoteToken?.symbol !== "SOL") continue;
    if (!pair.baseToken?.address) continue;
    if (seen.has(pair.baseToken.address)) continue;
    seen.add(pair.baseToken.address);

    const priceUsd = parseFloat(pair.priceUsd || 0);
    const solPrice = parseFloat(pair.priceUsd || 0) !== 0 ? parseFloat(pair.priceNative || 0) / parseFloat(pair.priceUsd || 0): 180;
    //console.log(i)
    tokens.push({
      token_address: pair.baseToken.address,
      token_name: pair.baseToken.name || 'Unknown',
      token_ticker: pair.baseToken.symbol || '???',
      price_sol: priceUsd / solPrice,
      market_cap_sol: (parseFloat(pair.fdv || 0)) / solPrice,
      volume_sol: (parseFloat(pair.volume?.h24 || 0)) / solPrice,
      liquidity_sol: (parseFloat(pair.liquidity?.usd || 0)) / solPrice,
      transaction_count: (pair.txns?.h24?.buys || 0) + (pair.txns?.h24?.sells || 0),
      price_1hr_change: parseFloat(pair.priceChange?.h1 || 0),
      price_6hr_change: parseFloat(pair.priceChange?.h6 || 0),
      price_24hr_change: parseFloat(pair.priceChange?.h24 || 0),
      protocol: pair.dexId || 'Unknown',
      updated_at: Date.now(),
    });


  }

  console.log(`Got ${tokens.length} REAL Solana tokens from DexScreener`);
  
  return tokens;
}

async function fetchGeckoTerminal() {
  const url = 'https://api.geckoterminal.com/api/v2/networks/solana/pools';
  console.log('Fetching GeckoTerminal...');
  let data;
  
  try {
    data = await fetchWithRetry(url);
    // console.log(data);
  } catch (err) {
    console.log('Geckoterminal failed');
    return [];
  }

  if (!data.data || !Array.isArray(data.data)) return [];

  const tokens = [];
  const seen = new Set();

  for (const pool of data.data) {
    const attrs = pool.attributes;
    const base = pool.relationships.base_token || {};

    // BEST METHOD: Check pool name contains "/ SOL"
    const poolName = (attrs.name || '').toUpperCase();
    //console.log(poolName.includes('/ SOL'))
    if (!poolName.includes('/ SOL')) continue;

    const tickerFromName = poolName.split('/')[0].trim();

    const address = base.data.id;
    if (!address || seen.has(address)) continue;
    seen.add(address);

    const priceUsd = parseFloat(attrs.base_token_price_usd || 0);
    const solPrice = parseFloat(data.quote_token_price_usd || 180);

    tokens.push({
      token_address: address,
      token_name: base.data.name || 'Unknown', //note: Geckoterminal doesn't have token_name
      token_ticker: tickerFromName || '???',
      price_sol: priceUsd / solPrice,
      market_cap_sol: parseFloat(attrs.fdv_usd || 0) / solPrice,
      volume_sol: parseFloat(attrs.volume_usd_h24 || 0) / solPrice,
      liquidity_sol: parseFloat(attrs.reserve_in_usd || 0) / solPrice,
      transaction_count: 
        (parseInt(attrs.transactions?.h24?.buys || 0) || 0) + 
        (parseInt(attrs.transactions?.h24?.sells || 0) || 0),
      price_1hr_change: parseFloat(attrs.price_change_percentage?.h1 || 0),
      price_6hr_change: parseFloat(attrs.price_change_percentage?.h6 || 0),
      price_24hr_change: parseFloat(attrs.price_change_percentage?.h24 || 0),
      protocol: attrs.pool_dex || 'Raydium',
      updated_at: Date.now(),
    });
  }

  console.log(`GeckoTerminal: ${tokens.length} real SOL meme tokens (via "/ SOL" filter)`);
  return tokens;
}

function mergeTokens(a, b) {
  const map = new Map();
  for (const t of [...a, ...b]) {
    const existing = map.get(t.token_address);
    if (!existing || t.liquidity_sol > existing.liquidity_sol) {
      map.set(t.token_address, { ...t, sources: existing?.sources? [...existing.sources, t.protocol] : [t.protocol] });//fix1
    }
  }
  return Array.from(map.values());
}

async function refreshData() {
  console.log('\n=== Refreshing meme coins ===');
  try {
    const [dex, gecko] = await Promise.all([fetchDexScreener(), fetchGeckoTerminal()]);
    const merged = mergeTokens(dex, gecko);
    cachedTokens = merged.sort((a, b) => b.volume_sol - a.volume_sol).slice(0, 1000);

    await redis.set(CACHE_KEY, JSON.stringify(cachedTokens), 'EX', CACHE_TTL);
    io.emit('tokens_update', cachedTokens.slice(0, 50));

    console.log(`SUCCESS: ${cachedTokens.length} unique tokens`);
  } catch (err) {
    console.error('Refresh failed:', err.message);
  }
}

async function getTokens() {
  const cached = await redis.get(CACHE_KEY);
  if (cached) cachedTokens = JSON.parse(cached);
  if (cachedTokens.length === 0) await refreshData();
  //console.log(cachedTokens.length);
  return cachedTokens;
}


/*app.get('/api/tokens', async (req, res) => {
  await getTokens();

  // FIX: Proper limit handling
  let { limit, timeframe = '1h' } = req.query;

  console.log(limit)

  let list = [...cachedTokens];

  
  const l_size = list.length
  console.log(l_size)
  
  if (timeframe === '24h') list = list.map(t => ({ ...t, price_1hr_change: t.price_1hr_change * 0.9 }));
  if (timeframe === '7d') list = list.map(t => ({ ...t, price_1hr_change: t.price_1hr_change * 0.7 }));

  
  let start = 0;

  const page = list.slice(start, start + Math.min(limit,l_size));
  

  res.json({
    data: page,
    pagination: {
      //nextCursor,
      //hasMore: !!nextCursor,
      total: list.length
    }
  });
});*/

// server.js (updated route)
app.get('/api/tokens', async (req, res) => {
  try {
    // 1. Query params
    const {
      period = '24hr',          // '1hr' | '6hr' | '24hr'
      sortBy = 'volume',        // 'volume' | 'price_change' | 'market_cap' | 'liquidity' | 'transaction_count'
      order = 'desc',           // 'asc' | 'desc'
      limit = 30,               // max items per page
      cursor = null             // next cursor (opaque string or timestamp)
    } = req.query;

    const limitNum = Math.min(parseInt(limit) || 50, 100); // safety cap

    // Validate params
    const validPeriods = ['1hr', '6hr', '24hr'];
    const validSortFields = [
      'volume', 'price_change', 'market_cap',
      'liquidity', 'transaction_count'
    ];
    if (!validPeriods.includes(period)) {
      return res.status(400).json({ error: 'Invalid period. Use 1hr, 6hr, or 24hr' });
    }
    if (!validSortFields.includes(sortBy)) {
      return res.status(400).json({ error: 'Invalid sortBy field' });
    }
    if (!['asc', 'desc'].includes(order.toLowerCase())) {
      return res.status(400).json({ error: 'order must be asc or desc' });
    }

    // 2. Map period → actual field names from your data
    const changeField = {
      '1hr': 'price_1hr_change',
      '6hr': 'price_6hr_change',
      '24hr': 'price_24hr_change'
    }[period];

    const volumeField = 'volume_sol';
    const mcField = 'market_cap_sol';

    // 3. Use cachedTokens (spread to avoid mutating the original)
    let list = [...cachedTokens]; // ← Changed from getAllTokensFromSource

    // 4. Cursor-based filtering (using updated_at timestamp)
    if (cursor) {
      const cursorTime = parseInt(cursor);
      if (!isNaN(cursorTime)) {
        list = list.filter(t => t.updated_at > cursorTime);
      }
    }

    // 5. Sorting logic
    list.sort((a, b) => {
      let aVal, bVal;

      if (sortBy === 'volume') {
        aVal = a.volume_sol;
        bVal = b.volume_sol;
      } else if (sortBy === 'price_change') {
        aVal = a[changeField] || 0;
        bVal = b[changeField] || 0;
      } else if (sortBy === 'market_cap') {
        aVal = a.market_cap_sol;
        bVal = b.market_cap_sol;
      } else if (sortBy === 'liquidity') {
        aVal = a.liquidity_sol;
        bVal = b.liquidity_sol;
      } else if (sortBy === 'transaction_count') {
        aVal = a.transaction_count;
        bVal = b.transaction_count;
      }

      const result = aVal > bVal ? 1 : aVal < bVal ? -1 : 0; // Handle equality
      return order.toLowerCase() === 'desc' ? -result : result;
    });

    // 6. Pagination slice
    const paginated = list.slice(0, limitNum);

    // 7. Next cursor (if more data exists)
    const hasMore = list.length > limitNum;
    const nextCursor = hasMore && paginated.length > 0
      ? paginated[paginated.length - 1].updated_at.toString()
      : null;

    // 8. Response
    res.json({
      data: paginated.map(t => ({
        token_address: t.token_address,
        token_name: t.token_name,
        token_ticker: t.token_ticker,
        price_sol: t.price_sol,
        market_cap_sol: t.market_cap_sol,
        volume_sol: t.volume_sol,
        liquidity_sol: t.liquidity_sol,
        transaction_count: t.transaction_count,
        price_change: t[changeField],  // dynamic based on period
        period: period,
        protocol: t.protocol,
        updated_at: t.updated_at
      })),
      pagination: {
        limit: limitNum,
        next_cursor: nextCursor,
        has_more: hasMore
      }
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

io.on('connection', socket => {
  console.log('Client connected');
  socket.emit('tokens_update', cachedTokens.slice(0, 50));
});

app.get('/health', (req, res)=> res.json({ status: 'ok', tokens: cachedTokens.length }));
// 
server.listen(PORT, async () => {
  console.log(`Server running on http://localhost:${PORT}`);
  await getTokens();
  setInterval(refreshData, REFRESH_INTERVAL);
});