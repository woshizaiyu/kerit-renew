# AGENTS.md — kerit-renew

Kerit Cloud（https://billing.kerit.cloud）免费 Discord Bot（每日 heartbeat，+1天/次）自动续期。
Node.js 18 + Playwright + GitHub Actions。底座：`aclclouds-renew`。

## 目录

- `renew.js` — 唯一脚本：API 预检 + 浏览器续期 + TG 报告（含 `--selftest`）
- `.github/workflows/renew.yml` — CI：每日巡检 `10 10 * * *`；无 npm cache（无 lockfile）
- `package.json` / `README.md` / `.gitignore`
- 本地仅有（绝不提交）：`.tmp/`（录制，含真实 cookie）、`screenshots/`

## 核心设计（改代码前必读）

1. 门控与前端 `renderFree` 同构：`renewDisabled = capReached || atCeiling || abuse`。
   `capReached = renews_this_week >= renews_per_week(7)`；
   `atCeiling = seconds_left > (max_days-1)*86400`；`abuse`=TOS 违规（按钮不渲染）。
   数据源 `GET /api/free/status`（纯 cookie）。SKIP=免开浏览器，GO=走浏览器。
2. 认证是 session-cookie：`kc_session` + `kc_salt` + `kc_did`；页内请求头由
   `KGUARD_B.attachHeaders` 自动带（kguard PoW），Node 侧不仿造——复核用页内 fetch。
3. 续期按钮 `#free-renew-btn`（稳定 id）：等出现→读 `.fh-hint`→等使能（30s）→点→
   toast `Heartbeat sent — +1 day` + `seconds_left` +86400 复核。`disabled` 初态正常。
4. 续期链：`POST /api/free/prepare {action:'renew'}` → `action_token`（240s 有效，
   需 dwell `min_dwell_ms+80ms`）→ `POST /api/free/renew {captcha, action_token}`，
   全由页内 JS 完成，脚本只点按钮。`[CALIBRATE]` 三处待可续期录制确认。
5. 代理：`NODE_LINK` → workflow 起 sing-box → 脚本读 `IS_PROXY`/`PROXY_SERVER`，
   TCP 探测 1080，不通自动直连。不配即直连。

## 常用命令

```bash
npm install
node --check renew.js
node renew.js --selftest
# 演练（不点击）：DRY_RUN=true HEADLESS=false npm start
```

## 环境变量

`AUTH_STATE`（storageState 纯 JSON）与 `KERIT_EMAIL`+`KERIT_PASSWORD` 二选一；
`GH_TOKEN`+`AUTO_UPDATE_STATE` 回写登录态；`TG_BOT_TOKEN`/`TG_CHAT_ID`；`NODE_LINK` 可选。

## CI 铁律（踩过坑）

- `if:` 里禁用 `secrets` 上下文（会 Invalid workflow file），secret 判空放 `run:` 里或让脚本兜底。
- `setup-node` 不要开 `cache: npm`（本仓无 lockfile，`npm ci` 会挂），用 `npm install`。
- 录制/登录态文件永远不进仓库（`.gitignore` 已覆盖 `.tmp/`、`storage-state*.json`）。

## 上游约定（佬王 eooce 系，已验证）

- sing-box 同源：workflow 用 `https://main.ssss.nyc.mn/setup_proxy.sh`，与
  `eooce/Auto-Renew-HidenCloud` 一字不差；成功时写 `GITHUB_ENV`
  （`IS_PROXY`/`PROXY_SERVER`），脚本只读这两个 env，不自建代理变量。
- TG 通知风格对齐 `eooce/Auto-Renew-HidenCloud`：标题 `🎰 <平台> 续期报告` +
  状态行 + `📧 账号`（邮箱前后2位脱敏）+ `⏱ 续期前/后剩余时间`，
  `parse_mode: HTML` 直发。
