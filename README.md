# kerit-renew

Kerit Cloud（https://billing.kerit.cloud）免费 Discord Bot 每日 heartbeat 自动续期。
Node.js 18 + Playwright + GitHub Actions。底座复用 `aclclouds-renew`。

## 续期规则（官方文档 + 前端逆向）

- 每天-1天、每天可续1次、每周上限7次、归零自动停机；每用户仅1台免费机。
- 门控与前端同构：`renewDisabled = capReached || atCeiling || abuse`。
- 续期链：`POST /api/free/prepare` 取 `action_token` → 点 `#free-renew-btn` →
  `POST /api/free/renew {captcha, action_token}` → toast `Heartbeat sent — +1 day`。

## 目录

- `renew.js` — 唯一脚本：API 预检 + 浏览器续期 + TG 报告（含 `--selftest` 门控单测）
- `.github/workflows/renew.yml` — CI：每日巡检 `10 10 * * *`；无 npm cache（无 lockfile）
- `package.json` / `README.md` / `.gitignore` / `AGENTS.md`
- 本地仅有（绝不提交）：`.tmp/`（录制，含真实 cookie）、`screenshots/`

## 常用命令

```bash
npm install
node --check renew.js
node renew.js --selftest
# 演练（不点击）：DRY_RUN=true HEADLESS=false npm start
```

## 环境变量

`AUTH_STATE`（storageState 纯 JSON，可用 `.tmp/agentscribe-shield-auth-*.json` 转换）与
`KERIT_EMAIL`+`KERIT_PASSWORD` 二选一；`GH_TOKEN`+`AUTO_UPDATE_STATE` 回写登录态；
`TG_BOT_TOKEN`/`TG_CHAT_ID`；`NODE_LINK` 可选。

## 待校准（需一次可续期录制确认，见 renew.js 内 [CALIBRATE] 标记）

1. toast 容器选择器（现按 body 全文匹配成功文案）
2. 账密登录表单结构（best-effort，优先 AUTH_STATE）
3. `require_captcha=true` 时 invisible 是否免人工

## 二期（暂不做）

- cron 自我调度（Kerit 每日一续，固定 cron 即可，调度收益小）
- `ptlc_` 面板 key 巡检门控
