#!/usr/bin/env node
/* ============================================================================
   FORZZA — STATIC-IP RELAY (Render.com · خطة Free · بلا أي مكتبات)
   ----------------------------------------------------------------------------
   Render يُخرج كل نداءات هذه الخدمة من **عناوين IP ثابتة ومنشورة** لكل منطقة
   (تجدها في Render → خدمتك → Connect → Outbound). نضيف تلك العناوين في قائمة
   سماح لوحة Nexus ⇒ يصبح موقعنا على Vercel قادرًا على الوصول إلى الإنتاج
   api.nexusggr.eu بلا أي سيرفر ولا جهاز يبقى شغّالًا.

   العقد (نفس ما يفهمه موقعنا):
     GET  /healthz  → {ok, egressIp, target, uptimeSec}
     POST /          body {method, agent_code, agent_token, ...}   header x-relay-key
   أمان: هدف واحد ثابت · مفتاح إلزامي · لا تُسجَّل أجسام الطلبات (تحمل توكن المزوّد).
   ========================================================================== */
'use strict';
const http = require('node:http');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 8787);
const BIND = process.env.BIND || '0.0.0.0';                    // Render يحتاج 0.0.0.0
const RELAY_KEY = String(process.env.RELAY_KEY || '').trim();
const TARGET_URL = String(process.env.TARGET_URL || 'https://api.nexusggr.eu').trim().replace(/\/+$/, '');
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 25000);
const MAX_BODY = Number(process.env.MAX_BODY || 2 * 1024 * 1024);

if (!RELAY_KEY) { console.error('[relay] RELAY_KEY is required'); process.exit(1); }

const FORWARD = new Set(['content-type','accept','user-agent','authorization','x-api-key',
  'x-signature','x-merchant-id','x-timestamp','x-nonce','x-sign','x-agent-code','gh-access-key']);
for (const h of String(process.env.FORWARD_EXTRA_HEADERS || '').split(',')) {
  const n = h.trim().toLowerCase(); if (n) FORWARD.add(n);
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}
let eg = { ip: null, at: 0 };
async function egressIp() {
  if (eg.ip && Date.now() - eg.at < 300000) return eg.ip;
  for (const url of ['https://api.ipify.org?format=json', 'https://ifconfig.co/json']) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(4000) }); const j = await r.json();
      const ip = j.ip || j.address; if (ip) { eg = { ip, at: Date.now() }; return ip; } } catch (_) {}
  }
  return eg.ip || 'unknown';
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(new Error('too-large')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks))); req.on('error', reject);
  });
}
function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
  res.end(body);
}
http.createServer(async (req, res) => {
  const t0 = Date.now();
  if (req.method === 'GET' && (req.url === '/healthz' || req.url === '/health' || req.url === '/')) {
    return json(res, 200, { ok: true, service: 'forzza-static-ip-relay-render',
      egressIp: await egressIp(), target: TARGET_URL, uptimeSec: Math.round(process.uptime()) });
  }
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
  if (!safeEqual(req.headers['x-relay-key'], RELAY_KEY)) return json(res, 401, { ok: false, error: 'UNAUTHORIZED' });

  const override = String(req.headers['x-relay-path'] || '').trim();
  const path = override || (req.url === '/' ? '' : req.url);
  let upstream;
  try { upstream = new URL(TARGET_URL + (path.startsWith('/') || !path ? path : '/' + path)); }
  catch (_) { return json(res, 400, { ok: false, error: 'BAD_TARGET' }); }

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (FORWARD.has(k.toLowerCase()) && k.toLowerCase() !== 'x-relay-path') headers[k] = v;
  if (!headers['user-agent']) headers['user-agent'] = 'forzza-static-ip-relay/1.0';

  let body;
  try { body = (req.method === 'GET' || req.method === 'HEAD') ? undefined : await readBody(req); }
  catch (_) { return json(res, 413, { ok: false, error: 'BODY_TOO_LARGE' }); }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const up = await fetch(upstream, { method: req.method, headers, body, signal: ctrl.signal, redirect: 'manual' });
    const text = await up.text();
    res.writeHead(up.status, { 'content-type': up.headers.get('content-type') || 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text), 'cache-control': 'no-store' });
    res.end(text);
    console.log(`${req.method} ${path || '/'} -> ${up.status} ${Date.now() - t0}ms`);
  } catch (err) {
    const aborted = err && (err.name === 'AbortError' || err.code === 'ABORT_ERR');
    json(res, aborted ? 504 : 502, { ok: false, error: aborted ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNREACHABLE' });
  } finally { clearTimeout(timer); }
}).listen(PORT, BIND, () => {
  console.log(`[relay] listening on ${BIND}:${PORT} -> ${TARGET_URL}`);
  egressIp().then((ip) => console.log(`[relay] egress IP: ${ip}`));
});
