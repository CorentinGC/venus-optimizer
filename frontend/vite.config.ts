import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

/**
 * Vite plugin to expose local NDJSON log files via JSON and SSE endpoints during dev/preview.
 *
 * Endpoints:
 * - GET /api/actions → { ok, events }
 * - GET /api/balance → { ok, points }
 * - GET /api/actions/stream → SSE snapshots of { ok, events }
 * - GET /api/balance/stream → SSE snapshots of { ok, points }
 *
 * Paths resolution order (first existing wins):
 * - Env: LOG_* or SERVER_LOG_* / CLIENT_LOG_* paths
 * - Fallback: ../logs/* (repo root when run from frontend/)
 * - Fallback: logs/* (local to frontend/)
 */
function logSsePlugin(): Plugin {
  return {
    name: 'log-sse-plugin',
    configureServer(server) {
      const LOG_ACTIONS = resolveLogPath(
        ['LOG_ACTIONS', 'LOG_ACTIONS_PATH', 'SERVER_LOG_ACTIONS_PATH', 'CLIENT_LOG_ACTIONS_PATH'],
        path.join('logs', 'actions.ndjson'),
      );
      const LOG_BALANCE = resolveLogPath(
        ['LOG_BALANCE', 'LOG_BALANCE_PATH', 'SERVER_LOG_BALANCE_PATH', 'CLIENT_LOG_BALANCE_PATH'],
        path.join('logs', 'balance.ndjson'),
      );
      const LOG_BLOCKS = resolveLogPath(
        ['LOG_BLOCKS', 'LOG_BLOCKS_PATH', 'SERVER_LOG_BLOCKS_PATH', 'CLIENT_LOG_BLOCKS_PATH'],
        path.join('logs', 'per-block.ndjson'),
      );
      let MARKETS_JSON = resolveLogPath(
        ['DATA_MARKETS', 'SERVER_DATA_MARKETS_PATH', 'CLIENT_DATA_MARKETS_PATH', 'SERVER_LOG_MARKETS_PATH'],
        path.join('data', 'pools.json'),
      );
      // Fallback to markets.json if pools.json is absent
      try {
        const repoPools = path.resolve('..', 'data', 'pools.json');
        const repoMarkets = path.resolve('..', 'data', 'markets.json');
        const localPools = path.resolve('data', 'pools.json');
        const localMarkets = path.resolve('data', 'markets.json');
        if (!fs.existsSync(MARKETS_JSON)) {
          if (fs.existsSync(repoMarkets)) MARKETS_JSON = repoMarkets;
          else if (fs.existsSync(localMarkets)) MARKETS_JSON = localMarkets;
          else if (fs.existsSync(repoPools)) MARKETS_JSON = repoPools;
          else if (fs.existsSync(localPools)) MARKETS_JSON = localPools;
        }
      } catch {}
      const RESET_FLAG = resolveLogPath(
        ['DATA_RESET_FLAG', 'SERVER_DATA_RESET_PATH', 'CLIENT_DATA_RESET_PATH'],
        path.join('data', 'reset.flag'),
      );

      registerLogMiddlewares(server.middlewares, LOG_ACTIONS, LOG_BALANCE, LOG_BLOCKS, MARKETS_JSON, RESET_FLAG);
    },
    configurePreviewServer(server) {
      const LOG_ACTIONS = resolveLogPath(
        ['LOG_ACTIONS', 'LOG_ACTIONS_PATH', 'SERVER_LOG_ACTIONS_PATH', 'CLIENT_LOG_ACTIONS_PATH'],
        path.join('logs', 'actions.ndjson'),
      );
      const LOG_BALANCE = resolveLogPath(
        ['LOG_BALANCE', 'LOG_BALANCE_PATH', 'SERVER_LOG_BALANCE_PATH', 'CLIENT_LOG_BALANCE_PATH'],
        path.join('logs', 'balance.ndjson'),
      );
      const LOG_BLOCKS = resolveLogPath(
        ['LOG_BLOCKS', 'LOG_BLOCKS_PATH', 'SERVER_LOG_BLOCKS_PATH', 'CLIENT_LOG_BLOCKS_PATH'],
        path.join('logs', 'per-block.ndjson'),
      );
      let MARKETS_JSON = resolveLogPath(
        ['DATA_MARKETS', 'SERVER_DATA_MARKETS_PATH', 'CLIENT_DATA_MARKETS_PATH', 'SERVER_LOG_MARKETS_PATH'],
        path.join('data', 'pools.json'),
      );
      // Fallback to markets.json if pools.json is absent
      try {
        const repoPools = path.resolve('..', 'data', 'pools.json');
        const repoMarkets = path.resolve('..', 'data', 'markets.json');
        const localPools = path.resolve('data', 'pools.json');
        const localMarkets = path.resolve('data', 'markets.json');
        if (!fs.existsSync(MARKETS_JSON)) {
          if (fs.existsSync(repoMarkets)) MARKETS_JSON = repoMarkets;
          else if (fs.existsSync(localMarkets)) MARKETS_JSON = localMarkets;
          else if (fs.existsSync(repoPools)) MARKETS_JSON = repoPools;
          else if (fs.existsSync(localPools)) MARKETS_JSON = localPools;
        }
      } catch {}
      const RESET_FLAG = resolveLogPath(
        ['DATA_RESET_FLAG', 'SERVER_DATA_RESET_PATH', 'CLIENT_DATA_RESET_PATH'],
        path.join('data', 'reset.flag'),
      );

      registerLogMiddlewares(server.middlewares as any, LOG_ACTIONS, LOG_BALANCE, LOG_BLOCKS, MARKETS_JSON, RESET_FLAG);
    },
  };
}

/**
 * Initialize basic SSE response with keep-alive.
 */
function setupSse(res: any): void {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  res.write('retry: 2000\n\n');
  const keepAlive = setInterval(() => {
    res.write(': keep-alive\n\n');
  }, 15000);
  res.on('close', () => clearInterval(keepAlive));
}

/**
 * Send a JSON payload over SSE as a single message.
 */
function sendSseJSON(res: any, data: unknown): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/**
 * Watch a file for changes; best-effort support on platforms where fs.watch is flaky.
 * Falls back to polling for existence to trigger the initial snapshot when the file appears.
 */
function watchFile(filePath: string, onChange: () => void): fs.FSWatcher | undefined {
  try {
    const watcher = fs.watch(filePath, { persistent: true }, () => {
      onChange();
    });
    return watcher;
  } catch {
    const interval = setInterval(async () => {
      try {
        await fsp.stat(filePath);
        clearInterval(interval);
        onChange();
      } catch {
        // keep waiting
      }
    }, 2000);
    return undefined;
  }
}

/**
 * Register all /api/* routes for JSON and SSE snapshots backed by NDJSON files.
 */
function registerLogMiddlewares(middlewares: any, LOG_ACTIONS: string, LOG_BALANCE: string, LOG_BLOCKS?: string, MARKETS_JSON?: string, RESET_FLAG?: string): void {
  middlewares.use(async (req: any, res: any, next: any) => {
    if (!req.url) return next();
    if (req.method !== 'GET') return next();

    if (req.url.startsWith('/api/actions/stream')) {
      setupSse(res);
      const sendSnapshot = async () => {
        try {
          const events = await readNdjson(LOG_ACTIONS, 1000);
          sendSseJSON(res, { ok: true, events });
        } catch {
          sendSseJSON(res, { ok: true, events: [] });
        }
      };
      const watcher = watchFile(LOG_ACTIONS, sendSnapshot);
      await sendSnapshot();
      res.on('close', () => {
        watcher?.close();
      });
      return; // keep connection open
    }

    if (req.url.startsWith('/api/balance/stream')) {
      setupSse(res);
      const sendSnapshot = async () => {
        try {
          const points = await readNdjson(LOG_BALANCE, 5000);
          sendSseJSON(res, { ok: true, points });
        } catch {
          sendSseJSON(res, { ok: true, points: [] });
        }
      };
      const watcher = watchFile(LOG_BALANCE, sendSnapshot);
      await sendSnapshot();
      res.on('close', () => {
        watcher?.close();
      });
      return;
    }

    if (req.url.startsWith('/api/actions')) {
      try {
        const events = await readNdjson(LOG_ACTIONS, 1000);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, events }));
      } catch {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, events: [] }));
      }
      return;
    }

    if (req.url.startsWith('/api/balance')) {
      try {
        const points = await readNdjson(LOG_BALANCE, 5000);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, points }));
      } catch {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, points: [] }));
      }
      return;
    }

    if (MARKETS_JSON && req.url.startsWith('/api/markets/stream')) {
      setupSse(res);
      const sendSnapshot = async () => {
        try {
          const raw = await fsp.readFile(MARKETS_JSON, 'utf8');
          const data: any = JSON.parse(raw);
          const outDir = path.dirname(MARKETS_JSON);
          const enriched = await enrichMarketsWithHistoricalAverages(data, outDir);
          sendSseJSON(res, { ok: true, ...enriched });
        } catch {
          sendSseJSON(res, { ok: true, ts: null, markets: [] });
        }
      };
      const watcher = watchFile(MARKETS_JSON, sendSnapshot);
      await sendSnapshot();
      res.on('close', () => watcher?.close());
      return;
    }

    if (MARKETS_JSON && req.url.startsWith('/api/markets')) {
      try {
        const raw = await fsp.readFile(MARKETS_JSON, 'utf8');
        const data: any = JSON.parse(raw);
        const outDir = path.dirname(MARKETS_JSON);
        const enriched = await enrichMarketsWithHistoricalAverages(data, outDir);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, ...enriched }));
      } catch {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, ts: null, markets: [] }));
      }
      return;
    }

    if (req.url.startsWith('/api/reset')) {
      // Clear local logs to restart the simulation visually
      try {
        await fsp.writeFile(LOG_ACTIONS, '', 'utf8');
      } catch {}
      try {
        await fsp.writeFile(LOG_BALANCE, '', 'utf8');
      } catch {}
      if (LOG_BLOCKS) {
        try {
          await fsp.writeFile(LOG_BLOCKS, '', 'utf8');
        } catch {}
      }
      // Trigger simulator to reset via a flag file under data/
      if (RESET_FLAG) {
        try {
          await fsp.mkdir(path.dirname(RESET_FLAG), { recursive: true });
          await fsp.writeFile(RESET_FLAG, String(Date.now()), 'utf8');
        } catch {}
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    next();
  });
}

/**
 * Merge historical APY averages from local files under `outDir` using
 * data/old/{symbol}.json and data/{symbol}.json. Falls back gracefully.
 */
async function enrichMarketsWithHistoricalAverages(data: any, outDir: string): Promise<any> {
  try {
    const markets = Array.isArray(data?.markets) ? data.markets : [];
    if (!markets.length) return data ?? { ts: null, markets: [] };
    const enriched = await Promise.all(
      markets.map(async (m: any) => {
        const sym = String(m?.assetSymbol || m?.symbol || m?.asset || 'UNKNOWN').toLowerCase();
        // Only fresh data from pools/<symbol>.json
        const freshFile = path.resolve(outDir, 'pools', `${sym}.json`);
        const arrFresh = await readJsonArraySafe(freshFile);
        const { avg1m, avg3m, avg6m, avg1y } = calculateApyAveragesFromPoints(arrFresh, 'supply');
        const { avg1m: b1, avg3m: b3, avg6m: b6, avg1y: bY } = calculateApyAveragesFromPoints(arrFresh, 'borrow');
        return {
          ...m,
          avgSupplyApy1m: typeof avg1m === 'number' ? avg1m : m.avgSupplyApy1m,
          avgSupplyApy3m: typeof avg3m === 'number' ? avg3m : m.avgSupplyApy3m,
          avgSupplyApy6m: typeof avg6m === 'number' ? avg6m : m.avgSupplyApy6m,
          avgSupplyApy1y: typeof avg1y === 'number' ? avg1y : m.avgSupplyApy1y,
          avgBorrowApy1m: typeof b1 === 'number' ? b1 : m.avgBorrowApy1m,
          avgBorrowApy3m: typeof b3 === 'number' ? b3 : m.avgBorrowApy3m,
          avgBorrowApy6m: typeof b6 === 'number' ? b6 : m.avgBorrowApy6m,
          avgBorrowApy1y: typeof bY === 'number' ? bY : m.avgBorrowApy1y,
        };
      }),
    );
    return { ...data, markets: enriched };
  } catch {
    return data ?? { ts: null, markets: [] };
  }
}

async function readJsonArraySafe(filePath: string): Promise<any[]> {
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    const json = JSON.parse(raw);
    return Array.isArray(json) ? json : [];
  } catch {
    return [];
  }
}

type ApyPoint = { timestamp?: string | number; apy?: number | null; apyBase?: number | null; apyBaseBorrow?: number | null };

function calculateApyAveragesFromPoints(points: ApyPoint[], kind: 'supply' | 'borrow'): {
  avg1m?: number; avg3m?: number; avg6m?: number; avg1y?: number;
} {
  const nowMs = Date.now();
  const dayMs = 86400000;
  const ranges = [
    { key: 'avg1m' as const, ms: 30 * dayMs },
    { key: 'avg3m' as const, ms: 90 * dayMs },
    { key: 'avg6m' as const, ms: 180 * dayMs },
    { key: 'avg1y' as const, ms: 365 * dayMs },
  ];
  const res: any = {};
  for (const r of ranges) {
    const cutoff = nowMs - r.ms;
    const vals: number[] = [];
    for (const p of points) {
      const tVal = p?.timestamp;
      const ts = typeof tVal === 'number' ? tVal * (tVal < 10_000_000_000 ? 1000 : 1) : (tVal ? Date.parse(String(tVal)) : NaN);
      const apy = typeof p?.apy === 'number' ? p.apy : undefined; // treat as percent
      const raw = kind === 'borrow' ? (typeof p?.apyBaseBorrow === 'number' ? p.apyBaseBorrow : undefined)
                                    : (typeof p?.apyBase === 'number' ? p.apyBase : undefined);
      // Heuristic: most legacy files store percent (e.g., 1.5 = 1.5%), some rare new data might be decimal (< 0.01)
      const base = typeof raw === 'number' ? (raw > 0 && raw < 0.01 ? raw * 100 : raw) : undefined;
      const v = typeof apy === 'number' ? apy : base;
      if (Number.isFinite(ts) && ts >= cutoff && typeof v === 'number' && Number.isFinite(v)) {
        vals.push(v);
      }
    }
    const avg = computeAverage(vals);
    if (typeof avg === 'number') res[r.key] = avg;
  }
  return res;
}

function computeAverage(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const sum = values.reduce((a, b) => a + b, 0);
  const avg = sum / values.length;
  return Number.isFinite(avg) ? avg : undefined;
}

/**
 * Resolve a log file path from a set of environment variables with safe fallbacks.
 *
 * @param envKeys Ordered list of env var names to try.
 * @param defaultRelative Repo-relative default (e.g., 'logs/actions.ndjson').
 * @returns Absolute path to use.
 */
function resolveLogPath(envKeys: string[], defaultRelative: string): string {
  const candidates: string[] = [];
  for (const key of envKeys) {
    const val = process.env[key];
    if (val && String(val).trim()) {
      candidates.push(path.resolve(String(val).trim()));
    }
  }
  // Prefer repo-root fallback (../logs/...), then local (logs/...)
  candidates.push(path.resolve('..', defaultRelative));
  candidates.push(path.resolve(defaultRelative));

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      // ignore
    }
  }
  // If none exists yet (created later), still return repo-root fallback
  return path.resolve('..', defaultRelative);
}

async function readNdjson(filePath: string, limit: number): Promise<any[]> {
  const content = await fsp.readFile(filePath, 'utf8');
  const lines = content.split(/\r?\n/).filter(Boolean);
  const slice = lines.slice(-Math.max(1, Math.min(limit, 100000)));
  const out: any[] = [];
  for (const line of slice) {
    try {
      const obj = JSON.parse(line);
      out.push(obj);
    } catch {
      // skip
    }
  }
  return out;
}

export default defineConfig({
  plugins: [react(), logSsePlugin()],
  resolve: {
    alias: {
      $: path.resolve(__dirname, 'src'),
      '@components': path.resolve(__dirname, 'src/components'),
      '@ui': path.resolve(__dirname, 'src/components/ui'),
    },
  },
  server: {
    port: 5173,
    strictPort: false,
  },
});

