# Free-IP

Cloudflare Workers + D1 的代理节点控制面 MVP。用于管理你自己拥有或明确获授权使用的住宅/出口代理节点。

## 功能

- D1 保存 HTTP / HTTPS / SOCKS5 节点元数据
- REST API：健康检查、列表、随机节点、统计、添加、删除
- TXT / JSON 订阅输出
- 简单 Web Dashboard
- Cron 定时任务框架
- 管理 API 使用 `Authorization: Bearer <ADMIN_TOKEN>`

> 注意：Cloudflare Worker 不能直接充当 HTTP/SOCKS5 代理，也不能凭空产生住宅 IP。当前 Worker 是控制面。真实的代理可用性、延迟和出口验证应由你自己的授权节点/检查器完成，再把结果写回 D1。SOCKS5 在 Worker 中不会被伪装成 HTTP 检测。

## 部署

1. 安装依赖：

```bash
npm install
```

2. 创建 D1：

```bash
npx wrangler d1 create free-ip-db
```

把命令返回的 `database_id` 写入 `wrangler.toml`，替换 `REPLACE_WITH_D1_DATABASE_ID`。

3. 执行迁移：

```bash
npx wrangler d1 migrations apply free-ip-db --remote
```

4. 设置管理密钥：

```bash
npx wrangler secret put ADMIN_TOKEN
```

5. 本地运行：

```bash
npm run dev
```

6. 部署：

```bash
npm run deploy
```

## API

- `GET /api/health`
- `GET /api/stats`
- `GET /api/proxies?status=online&limit=50`
- `GET /api/random`
- `POST /api/proxies`（管理权限）
- `DELETE /api/proxies/:id`（管理权限）
- `POST /api/check`（管理权限；仅标记 Worker 无法直接检测的节点）
- `GET /sub.txt`
- `GET /sub.json`

添加节点示例：

```bash
curl -X POST "$WORKER_URL/api/proxies" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"scheme":"http","host":"192.0.2.10","port":8080,"country":"US","source":"owned-node"}'
```

## 后续版本

建议下一步增加一个独立的、只连接授权代理的 checker agent：它负责真正通过 HTTP/SOCKS5 出口访问测试站点，并把 `online/offline/latency_ms` 回写到 Worker API。这样既符合 Cloudflare Worker 的运行模型，也不会把 Worker 变成公开代理中继。
