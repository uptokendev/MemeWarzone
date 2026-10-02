#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs";

const upstream = String(process.env.CERT_UPSTREAM_RPC || "").trim();
const kind = String(process.env.CERT_RPC_KIND || "").trim();
const cutoffFile = String(process.env.CERT_CUTOFF_FILE || "").trim();
const port = Number(process.env.CERT_PROXY_PORT || 0);
if (!upstream || !/^https?:\/\//i.test(upstream)) throw new Error("CERT_UPSTREAM_RPC is required");
if (!['evm','solana'].includes(kind)) throw new Error("CERT_RPC_KIND must be evm or solana");
if (!cutoffFile || !port) throw new Error("CERT_CUTOFF_FILE and CERT_PROXY_PORT are required");

const cutoff = () => Number(fs.readFileSync(cutoffFile, "utf8").trim());
const hex = (n) => `0x${Math.max(0, Number(n)).toString(16)}`;

function clampEvm(body, limit) {
  const method = body?.method;
  if (method === 'eth_blockNumber') return { localResult: hex(limit) };
  const params = Array.isArray(body?.params) ? structuredClone(body.params) : [];
  if (method === 'eth_getLogs' && params[0] && typeof params[0] === 'object') {
    const filter = params[0];
    const from = filter.fromBlock === 'latest' ? limit : Number.parseInt(String(filter.fromBlock || '0x0'), 16);
    const to = filter.toBlock === 'latest' || filter.toBlock == null ? limit : Number.parseInt(String(filter.toBlock), 16);
    if (from > limit) return { localResult: [] };
    filter.fromBlock = hex(from);
    filter.toBlock = hex(Math.min(to, limit));
  }
  if ((method === 'eth_getBlockByNumber' || method === 'eth_getBlockTransactionCountByNumber') && params[0] === 'latest') params[0] = hex(limit);
  return { params };
}

function clampSolana(body, limit) {
  const method = body?.method;
  if (method === 'getSlot' || method === 'getBlockHeight') return { localResult: limit };
  return { params: Array.isArray(body?.params) ? structuredClone(body.params) : [] };
}

async function forward(body, limit) {
  const rule = kind === 'evm' ? clampEvm(body, limit) : clampSolana(body, limit);
  if ('localResult' in rule) return { jsonrpc: '2.0', id: body.id ?? 1, result: rule.localResult };
  const response = await fetch(upstream, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, params: rule.params }),
  });
  const payload = await response.json();
  if (kind === 'solana' && body?.method === 'getSignaturesForAddress' && Array.isArray(payload?.result)) {
    payload.result = payload.result.filter((item) => Number(item?.slot || 0) <= limit);
  }
  return payload;
}

const server = http.createServer(async (req, res) => {
  try {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}');
    const limit = cutoff();
    const payload = Array.isArray(body)
      ? await Promise.all(body.map((entry) => forward(entry, limit)))
      : await forward(body, limit);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  } catch (error) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'certification proxy failure', message: String(error?.message || error) }));
  }
});

server.listen(port, '127.0.0.1', () => {
  // Never log the upstream URL; BlockPI is treated as exposed.
  console.log(JSON.stringify({ ready: true, kind, port, cutoffFile }));
});
