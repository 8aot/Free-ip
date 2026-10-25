interface Env {
  DB: D1Database;
  ADMIN_TOKEN?: string;
  CHECK_TARGET?: string;
}

type ProxyRow = {
  id: number;
  scheme: string;
  host: string;
  port: number;
  username?: string | null;
  password?: string | null;
  country?: string | null;
  isp?: string | null;
  source?: string | null;
  latency_ms?: number | null;
  status: string;
  fail_count: number;
  last_checked_at?: string | null;
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

function auth(request: Request, env: Env): boolean {
  if (!env.ADMIN_TOKEN) return false;
  return request.headers.get("authorization") === `Bearer ${env.ADMIN_TOKEN}`;
}

function proxyUrl(p: ProxyRow): string {
  const credentials = p.username ? `${encodeURIComponent(p.username)}${p.password ? `:${encodeURIComponent(p.password)}` : ""}@` : "";
  return `${p.scheme}://${credentials}${p.host}:${p.port}`;
}

async function checkProxy(p: ProxyRow, target: string): Promise<{ ok: boolean; latency: number | null }> {
  if (p.scheme === "socks5") return { ok: false, latency: null };
  const started = Date.now();
  try {
    const response = await fetch(target, {
      cf: { resolveOverride: p.host },
      headers: { "x-proxy-pool-upstream": proxyUrl(p) },
      signal: AbortSignal.timeout(8000),
    });
    return { ok: response.ok, latency: Date.now() - started };
  } catch {
    return { ok: false, latency: null };
  }
}

async function runChecks(env: Env, limit = 50) {
  const rows = await env.DB.prepare(
    "SELECT * FROM proxies WHERE status != 'offline' OR last_checked_at IS NULL ORDER BY COALESCE(last_checked_at, '') ASC LIMIT ?"
  ).bind(limit).all<ProxyRow>();
  const target = env.CHECK_TARGET || "https://www.cloudflare.com/cdn-cgi/trace";
  let checked = 0;
  for (const p of rows.results || []) {
    const result = await checkProxy(p, target);
    const now = new Date().toISOString();
    if (p.scheme === "socks5") {
      await env.DB.prepare("UPDATE proxies SET status='unsupported', last_checked_at=?, updated_at=? WHERE id=?").bind(now, now, p.id).run();
    } else if (result.ok) {
      await env.DB.prepare("UPDATE proxies SET status='online', latency_ms=?, fail_count=0, last_checked_at=?, updated_at=? WHERE id=?").bind(result.latency, now, now, p.id).run();
    } else {
      await env.DB.prepare("UPDATE proxies SET status='offline', latency_ms=NULL, fail_count=fail_count+1, last_checked_at=?, updated_at=? WHERE id=?").bind(now, now, p.id).run();
    }
    checked++;
  }
  return checked;
}

const dashboard = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Free-IP Proxy Pool</title><style>body{font-family:system-ui;margin:40px;max-width:1100px}table{width:100%;border-collapse:collapse}td,th{padding:8px;border-bottom:1px solid #ddd;text-align:left}code{background:#f4f4f4;padding:2px 5px}</style></head><body><h1>Free-IP Proxy Pool</h1><p>Cloudflare Worker 控制面 · 仅用于你拥有或获授权使用的代理节点</p><div id="stats">加载中…</div><p><a href="/api/proxies">代理 JSON</a> · <a href="/sub.txt">订阅 TXT</a> · <a href="/sub.json">订阅 JSON</a></p><table><thead><tr><th>ID</th><th>协议</th><th>地址</th><th>国家</th><th>延迟</th><th>状态</th><th>检测时间</th></tr></thead><tbody id="rows"></tbody></table><script>async function load(){const [s,p]=await Promise.all([fetch('/api/stats').then(r=>r.json()),fetch('/api/proxies?limit=100').then(r=>r.json())]);document.querySelector('#stats').textContent='在线 '+s.online+' / 总数 '+s.total+' · 离线 '+s.offline;document.querySelector('#rows').innerHTML=p.proxies.map(x=>`<tr><td>${x.id}</td><td>${x.scheme}</td><td><code>${x.host}:${x.port}</code></td><td>${x.country||'-'}</td><td>${x.latency_ms==null?'-':x.latency_ms+' ms'}</td><td>${x.status}</td><td>${x.last_checked_at||'-'}</td></tr>`).join('')}load()</script></body></html>`;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/") return new Response(dashboard, { headers: { "content-type": "text/html; charset=utf-8" } });
    if (url.pathname === "/api/health") return json({ ok: true, service: "free-ip", time: new Date().toISOString() });

    if (url.pathname === "/api/stats" && request.method === "GET") {
      const row = await env.DB.prepare("SELECT COUNT(*) total, SUM(CASE WHEN status='online' THEN 1 ELSE 0 END) online, SUM(CASE WHEN status='offline' THEN 1 ELSE 0 END) offline, SUM(CASE WHEN status='unsupported' THEN 1 ELSE 0 END) unsupported FROM proxies").first<{total:number;online:number|null;offline:number|null;unsupported:number|null}>();
      return json({ total: row?.total || 0, online: row?.online || 0, offline: row?.offline || 0, unsupported: row?.unsupported || 0 });
    }

    if (url.pathname === "/api/proxies" && request.method === "GET") {
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 50), 1), 200);
      const status = url.searchParams.get("status");
      const country = url.searchParams.get("country");
      let sql = "SELECT id,scheme,host,port,country,isp,source,latency_ms,status,fail_count,last_checked_at FROM proxies";
      const args: (string|number)[] = [];
      const where: string[] = [];
      if (status) { where.push("status=?"); args.push(status); }
      if (country) { where.push("country=?"); args.push(country); }
      if (where.length) sql += " WHERE " + where.join(" AND ");
      sql += " ORDER BY CASE status WHEN 'online' THEN 0 ELSE 1 END, latency_ms ASC LIMIT ?";
      args.push(limit);
      const result = await env.DB.prepare(sql).bind(...args).all();
      return json({ proxies: result.results || [] });
    }

    if (url.pathname === "/api/random" && request.method === "GET") {
      const p = await env.DB.prepare("SELECT id,scheme,host,port,country,isp,latency_ms,status FROM proxies WHERE status='online' ORDER BY RANDOM() LIMIT 1").first();
      return p ? json(p) : json({ error: "no_online_proxy" }, 404);
    }

    if (url.pathname === "/api/proxies" && request.method === "POST") {
      if (!auth(request, env)) return json({ error: "unauthorized" }, 401);
      const body = await request.json<Partial<ProxyRow>>();
      if (!body.scheme || !body.host || !body.port || !["http","https","socks5"].includes(body.scheme)) return json({ error: "invalid_proxy" }, 400);
      try {
        const result = await env.DB.prepare("INSERT INTO proxies (scheme,host,port,username,password,country,isp,source) VALUES (?,?,?,?,?,?,?,?) RETURNING id").bind(body.scheme, body.host, body.port, body.username || null, body.password || null, body.country || null, body.isp || null, body.source || null).first<{id:number}>();
        return json({ id: result?.id }, 201);
      } catch (e) { return json({ error: "duplicate_or_invalid_proxy", detail: String(e) }, 409); }
    }

    const deleteMatch = url.pathname.match(/^\/api\/proxies\/(\d+)$/);
    if (deleteMatch && request.method === "DELETE") {
      if (!auth(request, env)) return json({ error: "unauthorized" }, 401);
      await env.DB.prepare("DELETE FROM proxies WHERE id=?").bind(Number(deleteMatch[1])).run();
      return json({ ok: true });
    }

    if (url.pathname === "/api/check" && request.method === "POST") {
      if (!auth(request, env)) return json({ error: "unauthorized" }, 401);
      return json({ checked: await runChecks(env, 100) });
    }

    if (url.pathname === "/sub.json") {
      const result = await env.DB.prepare("SELECT scheme,host,port,country,isp,latency_ms FROM proxies WHERE status='online' ORDER BY latency_ms ASC LIMIT 500").all();
      return json({ generated_at: new Date().toISOString(), proxies: result.results || [] }, 200);
    }
    if (url.pathname === "/sub.txt") {
      const result = await env.DB.prepare("SELECT scheme,host,port FROM proxies WHERE status='online' ORDER BY latency_ms ASC LIMIT 500").all<{scheme:string;host:string;port:number}>();
      const text = (result.results || []).map(p => `${p.scheme}://${p.host}:${p.port}`).join("\n") + "\n";
      return new Response(text, { headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    return json({ error: "not_found" }, 404);
  },
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    await runChecks(env, 100);
  }
};
