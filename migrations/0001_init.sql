CREATE TABLE IF NOT EXISTS proxies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scheme TEXT NOT NULL CHECK (scheme IN ('http','https','socks5')),
  host TEXT NOT NULL,
  port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
  username TEXT,
  password TEXT,
  country TEXT,
  isp TEXT,
  source TEXT,
  latency_ms INTEGER,
  status TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown','online','offline','unsupported')),
  fail_count INTEGER NOT NULL DEFAULT 0,
  last_checked_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (scheme, host, port, username)
);

CREATE INDEX IF NOT EXISTS idx_proxies_status ON proxies(status);
CREATE INDEX IF NOT EXISTS idx_proxies_country ON proxies(country);
CREATE INDEX IF NOT EXISTS idx_proxies_checked ON proxies(last_checked_at);
