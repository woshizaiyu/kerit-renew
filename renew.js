#!/usr/bin/env node
/**
 * ============================================================================
 *  Kerit Cloud (https://billing.kerit.cloud) 免费 Discord Bot 每日续期
 * ----------------------------------------------------------------------------
 *  技术栈 : Node.js 18+ / Playwright (Chromium) / GitHub Actions
 *  底座   : aclclouds-renew（配置区/env/代理探活/TG/截图风格直接复用）
 *  录制   : kerit-renew/.tmp（AgentScribe bundle + kguard apilog）
 *  关键发现（前端 ca37e2d1ce2d.js 逆向，已确认）:
 *    GET  /api/free/status（纯 cookie）→ _freeData：
 *      has_server / enabled / require_kguard / require_captcha /
 *      renews_per_week(默认7) / max_days(默认7) /
 *      server.{renews_this_week, seconds_left, suspended, provisioned, uuid}
 *    门控（与前端 renderFree 完全同构）:
 *      renewDisabled = capReached || atCeiling || abuse
 *      capReached = renews_this_week >= renews_per_week
 *      atCeiling  = seconds_left > (max_days - 1) * 86400
 *      abuse      = TOS 违规（按钮不渲染，永久不可续）
 *    续期链 : freeRenew() → _freeEnsureToken()取验证token
 *      → renewFreeServer() → POST /api/free/renew {captcha, action_token}
 *      action_token 来自 POST /api/free/prepare {action:'renew', fingerprint:''}
 *      （token 有效期 240s，使用前需满足 min_dwell_ms+80ms；kguard 头由页内
 *      KGUARD_B.attachHeaders 自动带，Node 侧不仿造）
 *    成功标志：toast 'Heartbeat sent — +1 day. ✨' + seconds_left +86400
 *    按钮：#free-renew-btn（稳定 id，disabled 为初始态，需等使能）
 *  主路线 : API 预检（SKIP 免开浏览器）+ 浏览器点 heartbeat（页内 fetch 复核）。
 *  待校准（B 方案推断项，需一次可续期录制确认，已标 [CALIBRATE]）:
 *    1) toast 容器选择器（现按 body 全文匹配成功文案）
 *    2) 账密登录表单结构（best-effort，优先 AUTH_STATE）
 *    3) require_captcha=true 时 invisible 自动 execute 是否免人工
 *
 *  必填环境变量（二选一提供凭证）:
 *    AUTH_STATE / AUTH_STATE_FILE        Playwright storageState JSON（推荐）
 *    KERIT_EMAIL / KERIT_PASSWORD        账密登录（best-effort）
 *  可选环境变量:
 *    DASHBOARD_URL / GH_TOKEN + AUTO_UPDATE_STATE / TG_BOT_TOKEN / TG_CHAT_ID
 *  网络   : NODE_LINK 经 sing-box 本地代理（参考 HidenCloud），代理不可连自动直连。
 *    DRY_RUN / HEADLESS / TIMEZONE / LOCALE / NAV_TIMEOUT
 * ============================================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
// playwright 延迟加载：--selftest 无依赖可跑

/* ============================== 配置区 ============================== */

const env = (k, d = '') => (process.env[k] === undefined ? d : String(process.env[k])).trim() || d;
const bool = (k, d = false) => {
  const v = env(k).toLowerCase();
  if (!v) return d;
  return ['1', 'true', 'yes', 'y', 'on'].includes(v);
};
const num = (k, d) => {
  const v = parseFloat(env(k));
  return Number.isFinite(v) ? v : d;
};

const CFG = {
  dashboardUrl: env('DASHBOARD_URL', 'https://billing.kerit.cloud/dashboard'),
  apiBase: env('API_BASE', 'https://billing.kerit.cloud'),
  email: env('KERIT_EMAIL'),
  password: env('KERIT_PASSWORD'),
  authStateRaw: env('AUTH_STATE'),
  authStateFile: env('AUTH_STATE_FILE'),
  ghToken: env('GH_TOKEN'),
  autoUpdateState: bool('AUTO_UPDATE_STATE', false),
  repo: env('GITHUB_REPOSITORY'),
  tgToken: env('TG_BOT_TOKEN'),
  tgChatId: env('TG_CHAT_ID'),
  proxyUrl: env('PROXY_URL') || (env('IS_PROXY').toLowerCase() === 'true' ? env('PROXY_SERVER') : ''),
  headless: bool('HEADLESS', true),
  dryRun: bool('DRY_RUN', false),
  timezone: env('TIMEZONE', 'Asia/Shanghai'),
  locale: env('LOCALE', 'en-US'),
  channel: env('BROWSER_CHANNEL'),
  navTimeout: num('NAV_TIMEOUT', 90000),
  shotDir: env('SHOT_DIR', 'screenshots'),
  ua: env('USER_AGENT',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'),
};

/* ============================== 小工具 ============================== */

const nowStr = () => new Date().toLocaleString('zh-CN', { hour12: false });
const log = (...a) => console.log(`[${nowStr()}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** page.goto 带重试：ERR_CONNECTION_RESET 等网络抖动退避重试 */
async function gotoRetry(page, url, opts = {}, retries = 3) {
  let last;
  for (let i = 1; i <= retries; i++) {
    try { return await page.goto(url, opts); } catch (e) {
      last = e;
      log(`⚠️ 导航失败(${i}/${retries}): ${String(e.message).split('\n')[0].slice(0, 120)}`);
      if (i < retries) await sleep(3000 * i);
    }
  }
  throw last;
}

/** TCP 探测 host:port 是否可连（sing-box 存活校验），不通自动直连 */
function tcpProbe(host, port, ms = 5000) {
  return new Promise((resolve) => {
    const net = require('net');
    const s = new net.Socket();
    let done = false;
    const fin = (ok) => { if (!done) { done = true; s.destroy(); resolve(ok); } };
    s.setTimeout(ms);
    s.once('connect', () => fin(true));
    s.once('timeout', () => fin(false));
    s.once('error', () => fin(false));
    s.connect(port, host);
  });
}

function parseProxyHostPort(p) {
  try {
    const u = new URL(p);
    if (!u.hostname || !u.port) return null;
    return { host: u.hostname, port: Number(u.port) };
  } catch { return null; }
}

/** 邮箱脱敏（佬王 HidenCloud 风格：保留前后2位） */
function maskEmail() {
  const e = CFG.email || '';
  if (e.includes('@')) {
    const [name, domain] = e.split('@', 2);
    return name.length > 4 ? `${name.slice(0, 2)}****${name.slice(-2)}@${domain}` : `${name}@${domain}`;
  }
  return e ? `${e.slice(0, 2)}****` : 'AUTH_STATE登录';
}

/** 原生 https 发 TG 通知（佬王风格：parse_mode HTML，直发无降级） */
function sendTelegram(text) {
  return new Promise((resolve) => {
    if (!CFG.tgToken || !CFG.tgChatId) {
      log('⚠️ 未配置 TG_BOT_TOKEN / TG_CHAT_ID，跳过通知');
      return resolve(false);
    }
    const data = JSON.stringify({ chat_id: CFG.tgChatId, text, parse_mode: 'HTML' });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${CFG.tgToken}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 15000,
    }, (r) => {
      let buf = '';
      r.on('data', (c) => (buf += c));
      r.on('end', () => {
        try {
          const j = JSON.parse(buf);
          log(j.ok ? '📢 TG 通知已送达' : `⚠️ TG 通知失败: ${(j.description || buf).slice(0, 120)}`);
          resolve(!!j.ok);
        } catch { log('⚠️ TG 响应解析失败'); resolve(false); }
      });
    });
    req.on('error', (e) => { log(`⚠️ TG 发送异常: ${e.message}`); resolve(false); });
    req.on('timeout', () => { req.destroy(new Error('timeout')); resolve(false); });
    req.write(data);
    req.end();
  });
}

async function safeShot(page, name) {
  try {
    if (!fs.existsSync(CFG.shotDir)) fs.mkdirSync(CFG.shotDir, { recursive: true });
    const file = path.join(CFG.shotDir, name.endsWith('.png') ? name : `${name}.png`);
    await page.screenshot({ path: file, fullPage: false, timeout: 8000 });
    log(`📸 截图: ${file}`);
    return file;
  } catch (e) {
    log(`⚠️ 截图跳过: ${e.message}`);
    return null;
  }
}

/* ============================== 登录态 ============================== */

/** 读取 AUTH_STATE（内联 JSON / base64(JSON) / 文件路径）；兼容 storageState: 前缀粘贴 */
function loadAuthState() {
  const candidates = [];
  if (CFG.authStateFile && fs.existsSync(CFG.authStateFile)) candidates.push(fs.readFileSync(CFG.authStateFile, 'utf8'));
  if (CFG.authStateRaw) candidates.push(CFG.authStateRaw);
  const stripPrefix = (s) => {
    const t = String(s || '').trim();
    const m = t.match(/^(?:(?:const|let|var)\s+)?storageState\s*[:=]\s*(\{[\s\S]*\})\s*;?\s*$/);
    if (m) return m[1];
    const i = t.indexOf('{');
    const j = t.lastIndexOf('}');
    if (i > 0 && j > i) {
      const sub = t.slice(i, j + 1);
      try { JSON.parse(sub); return sub; } catch { /* not json */ }
    }
    return t;
  };
  for (const c of candidates) {
    const cleaned = stripPrefix(c);
    const tries = [cleaned];
    try { tries.push(Buffer.from(cleaned, 'base64').toString('utf8')); } catch { /* ignore */ }
    for (const t of tries) {
      try {
        const j = JSON.parse(t);
        if (j && (Array.isArray(j.cookies) || Array.isArray(j.origins))) return j;
      } catch { /* ignore */ }
    }
  }
  if (CFG.authStateRaw) log(`⚠️ AUTH_STATE 已配置(${CFG.authStateRaw.length}字)但解析失败：需纯JSON{"cookies":[],"origins":[]}`);
  return null;
}

/** storageState → Cookie 请求头 */
function cookieHeaderFromState(state) {
  try {
    return (state.cookies || []).map((c) => `${c.name}=${c.value}`).join('; ');
  } catch { return ''; }
}

function httpsGetJson(urlStr, headers) {
  return new Promise((resolve) => {
    const u = new URL(urlStr);
    const req = https.get({
      hostname: u.hostname, path: u.pathname + u.search,
      headers: { 'User-Agent': CFG.ua, ...headers }, timeout: 20000,
    }, (r) => {
      let buf = '';
      r.on('data', (c) => (buf += c));
      r.on('end', () => resolve({ status: r.statusCode, body: buf }));
    });
    req.on('error', (e) => resolve({ status: 0, body: '', error: e.message }));
    req.on('timeout', () => { req.destroy(new Error('timeout')); resolve({ status: 0, body: '', error: 'timeout' }); });
  });
}

/* ============================== 门控（与前端 renderFree 同构） ============================== */

/**
 * 纯函数门控：输入 /api/free/status 回包，输出决策。
 * 前端原文: renewDisabled = capReached || atCeiling || abuse
 *   capReached = renews_this_week >= renews_per_week(默认7)
 *   atCeiling  = seconds_left > (max_days - 1) * 86400
 */
function decideGate(d) {
  if (!d || typeof d !== 'object') return { decision: 'FALLBACK', note: '状态回包为空' };
  if (d.has_server === false) return { decision: 'SKIP', note: '名下无免费机(has_server=false)，无需续期' };
  if (d.has_server !== true) return { decision: 'FALLBACK', note: '状态回包缺 has_server 字段' };
  const s = d.server || {};
  const abuse = !!(s.abuse || d.abuse);
  if (abuse) return { decision: 'FAIL', note: 'TOS 违规停机（按钮不渲染，永久不可续）' };
  if (s.suspended && !s.seconds_left) return { decision: 'GO', note: '已停机，需 heartbeat 拉起' };
  const renews = Number(s.renews_this_week || 0);
  const cap = Number(d.renews_per_week || 7);
  const maxDays = Number(d.max_days || 7);
  const left = Number(s.seconds_left || 0);
  if (renews >= cap) return { decision: 'SKIP', note: `本周次数用完(${renews}/${cap})`, left, renews, cap };
  if (left > (maxDays - 1) * 86400) return { decision: 'SKIP', note: `已顶满${maxDays}天 (剩余${Math.round(left / 86400 * 10) / 10}天)`, left, renews, cap };
  return { decision: 'GO', note: `可续期 (剩余${Math.round(left / 3600 * 10) / 10}h, 本周${renews}/${cap})`, left, renews, cap };
}

/**
 * API 预检：GET /api/free/status（纯 cookie，无 kguard 头要求）。
 * 返回 { decision: 'SKIP' | 'GO' | 'FAIL' | 'FALLBACK', note, data? }。
 */
async function apiFreeStatus(state) {
  if (!state) return { decision: 'FALLBACK', note: '无登录态' };
  const r = await httpsGetJson(`${CFG.apiBase}/api/free/status`, {
    Accept: 'application/json',
    Cookie: cookieHeaderFromState(state),
    Referer: `${CFG.apiBase}/dashboard`,
  });
  if (r.status === 401) return { decision: 'FALLBACK', note: '登录态失效(HTTP 401)，回退浏览器' };
  if (r.status !== 200) return { decision: 'FALLBACK', note: `HTTP ${r.status}${r.error ? `(${r.error})` : ''}，回退浏览器` };
  try {
    const j = JSON.parse(r.body);
    const g = decideGate(j);
    return { ...g, data: j };
  } catch { return { decision: 'FALLBACK', note: '回包无法解析，回退浏览器' }; }
}

/* ============================== 浏览器续期 ============================== */

/** 是否已登录：dashboard 外壳渲染（侧边栏+用户区），免费机卡片在 Free Hosting 子页 */
async function isLoggedIn(page) {
  try {
    const ok = await page.evaluate(() => {
      const txt = (document.body.innerText || '').slice(0, 3000);
      return /Systems Online|Free Hosting|My Servers/i.test(txt);
    }).catch(() => false);
    return !!ok;
  } catch { return false; }
}

/** 进入 Free Hosting 子页（dashboard 首页是总览，免费机卡片需点左侧导航） */
async function gotoFreeHosting(page) {
  // 已在子页则直接返回
  const hasBtn = await page.locator('#free-renew-btn, #free-body').first().isVisible({ timeout: 2000 }).catch(() => false);
  if (hasBtn) return true;
  const nav = page.locator('aside a:has-text("Free Hosting"), nav a:has-text("Free Hosting")').first();
  try {
    await nav.waitFor({ state: 'visible', timeout: 10000 });
    await nav.click({ timeout: 5000 });
    log('👆 已进入 Free Hosting 子页');
  } catch (e) {
    log(`⚠️ 未找到 Free Hosting 导航: ${String(e.message).slice(0, 100)}`);
    return false;
  }
  await page.locator('#free-body, #page-free').first().waitFor({ state: 'attached', timeout: 15000 }).catch(() => {});
  await sleep(2500);
  return true;
}

/** 页内读状态（页内 fetch 自动带 kguard 头+cookie，结果最准） */
async function pageFreeStatus(page) {
  try {
    return await page.evaluate(async () => {
      try {
        const r = await fetch('/api/free/status', { credentials: 'same-origin' });
        const j = await r.json().catch(() => ({}));
        return { ok: r.ok, status: r.status, data: j };
      } catch (e) { return { ok: false, status: 0, data: {}, error: String(e).slice(0, 100) }; }
    });
  } catch (e) { return { ok: false, status: 0, data: {}, error: e.message }; }
}

/**
 * 单次 heartbeat 续期（Kerit 单免费机，无多服循环）。
 * 流程：等 #free-renew-btn → 读 .fh-hint → 等使能 → [验证码就绪] → 点击
 *   → 等 toast/页面文案 → 页内重读 status 复核 seconds_left。
 */
async function renewHeartbeat(context, liveState) {
  const page = await context.newPage();
  const result = { status: 'FAIL', before: null, after: null, note: '' };
  const t0 = Date.now();
  log('\n──────── Kerit heartbeat 续期 ────────');

  try {
    await gotoRetry(page, CFG.dashboardUrl, { waitUntil: 'domcontentloaded', timeout: CFG.navTimeout });
    await sleep(3000);

    if (!(await isLoggedIn(page))) {
      result.note = '未登录/被重定向';
      await safeShot(page, 'kerit-nologin.png');
      return result;
    }

    // dashboard 首页是总览，先进 Free Hosting 子页
    if (!(await gotoFreeHosting(page))) {
      result.note = '未找到 Free Hosting 入口（可能 UI 改版，需补录）';
      result.status = 'NO_BUTTON';
      await safeShot(page, 'kerit-nofree.png');
      return result;
    }

    // 页内状态（before）
    const st0 = await pageFreeStatus(page);
    const g0 = st0.ok ? decideGate(st0.data) : { decision: 'FALLBACK', note: '页内状态读取失败' };
    result.before = st0.ok && st0.data.server ? `${Math.round(Number(st0.data.server.seconds_left || 0) / 3600 * 10) / 10}h` : '?';
    log(`⏱️ 续期前剩余: ${result.before} | 门控: ${g0.decision}(${g0.note})`);
    if (g0.decision === 'SKIP') {
      result.status = 'PENDING';
      result.note = g0.note;
      return result;
    }
    if (g0.decision === 'FAIL') {
      result.status = 'FAIL';
      result.note = g0.note;
      await safeShot(page, 'kerit-abuse.png');
      return result;
    }

    if (CFG.dryRun) { result.status = 'PENDING'; result.note = 'DRY_RUN 演练，未点击'; return result; }

    // 等按钮出现（abuse 时不存在）
    const btn = page.locator('#free-renew-btn');
    try {
      await btn.waitFor({ state: 'attached', timeout: 15000 });
    } catch {
      result.note = '按钮不存在（疑似 TOS 违规/未渲染，需人工确认）';
      result.status = 'NO_BUTTON';
      await safeShot(page, 'kerit-nobutton.png');
      return result;
    }
    const hint = await page.locator('.fh-hint').first().innerText().catch(() => '');
    if (hint) log(`📝 页面提示: ${hint.slice(0, 120)}`);

    // 等使能（周次数用完/顶满时会一直 disabled，30s 后按 SKIP 处理）
    try {
      await page.waitForFunction(
        () => { const b = document.getElementById('free-renew-btn'); return b && !b.disabled; },
        { timeout: 30000 },
      );
      log('🔘 按钮已使能');
    } catch {
      result.status = 'PENDING';
      result.note = hint ? `按钮持续 disabled: ${hint.slice(0, 100)}` : '按钮持续 disabled（周次数用完或已顶满）';
      await safeShot(page, 'kerit-disabled.png');
      return result;
    }

    // 验证码：interactive 模式需先点 hCaptcha checkbox（token 经回调填入），
    // invisible 才由页内自动 execute。token 就绪后再点续期，否则页内直接 toast 劝退。
    if (st0.ok && st0.data.require_captcha) {
      log('🛡️ 本次需要验证，点击 hCaptcha checkbox…');
      try {
        const frame = page.frameLocator('#free-captcha iframe').first();
        await frame.locator('#checkbox').click({ timeout: 10000 });
        log('👆 已点验证框，等待 token…');
      } catch (e) {
        log(`⚠️ 验证框点击失败: ${String(e.message).slice(0, 100)}`);
      }
      await safeShot(page, 'kerit-captcha.png');
      let tok = '';
      for (let i = 0; i < 30 && !tok; i++) {
        await sleep(2000);
        tok = await page.evaluate(() => {
          const el = document.querySelector('[name="h-captcha-response"]');
          return el ? (el.value || '') : '';
        }).catch(() => '');
      }
      if (tok) log('✅ 验证 token 已就绪');
      else log('⚠️ 未拿到验证 token（可能弹图片题），继续点击由页内逻辑判定');
    }
    await safeShot(page, 'kerit-before-click.png');

    await btn.click({ timeout: 8000 });
    log('👆 已点击 Send a heartbeat');
    await sleep(4000);
    await safeShot(page, 'kerit-after-click.png');

    // [CALIBRATE] toast 容器选择器待录制确认：现按 body 全文匹配成功文案
    const bodyText = await page.evaluate(() => (document.body.innerText || '').slice(0, 4000)).catch(() => '');
    const low = bodyText.toLowerCase();
    if (/please complete the human check/i.test(bodyText)) {
      result.status = 'FAIL';
      result.note = '需要人工验证（invisible 未自动通过），本次无法自动续期';
      return result;
    }
    if (/please wait a moment|too many|rate limit/i.test(low)) {
      result.status = 'PENDING';
      result.note = '触发限流/冷却，下次再试';
      return result;
    }

    // 复核：页内重读 status，seconds_left 增加约 86400 即成功
    await sleep(3000);
    const st1 = await pageFreeStatus(page);
    const left0 = st0.ok ? Number(st0.data.server.seconds_left || 0) : NaN;
    const left1 = st1.ok ? Number((st1.data.server || {}).seconds_left || 0) : NaN;
    result.after = st1.ok ? `${Math.round(left1 / 3600 * 10) / 10}h` : '未读取到';
    log(`🔍 复核: ${result.before} ➔ ${result.after}`);
    await safeShot(page, 'kerit-verify.png');

    if (/heartbeat sent|\+1 day/i.test(bodyText) || (Number.isFinite(left0) && Number.isFinite(left1) && left1 - left0 > 80000)) {
      result.status = 'SUCCESS';
      result.note = 'Heartbeat sent — +1 day';
      log('🎉 续期成功');
    } else if (/could not renew|not yet|all .* weekly heartbeats used|topped up/i.test(low)) {
      result.status = 'PENDING';
      result.note = '未到续期窗口/次数用完';
      log(`⏳ ${result.note}`);
    } else {
      result.status = 'FAIL';
      result.note = '点击完成但未能确认入账（待录制校准成功断言）';
      await safeShot(page, 'kerit-fail.png');
      log('❌ 后端未入账或无法确认');
    }
  } catch (e) {
    result.note = (result.note || '') + ` 异常: ${String(e.message).slice(0, 120)}`;
    await safeShot(page, 'kerit-error.png');
    log(`❌ 处理异常: ${e.message}`);
  } finally {
    await page.close().catch(() => {});
    log(`⌛ 用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
  return result;
}

/* ============================== 登录 ============================== */

/** [CALIBRATE] 账密登录 best-effort：登录页结构待录制确认，优先用 AUTH_STATE */
async function doLogin(page) {
  log('🔑 账密登录（best-effort）');
  await gotoRetry(page, `${CFG.apiBase}/dashboard`, { waitUntil: 'domcontentloaded', timeout: CFG.navTimeout });
  await sleep(2500);
  if (await isLoggedIn(page)) { log('✅ 已有有效登录态，跳过登录'); return true; }
  try {
    const email = page.locator('input[type="email"], input[name*="email" i]').first();
    const pass = page.locator('input[type="password"]').first();
    await email.waitFor({ state: 'visible', timeout: 20000 });
    await email.fill(CFG.email);
    await pass.fill(CFG.password);
    await email.press('Enter').catch(() => {});
    await sleep(3000);
  } catch (e) {
    log(`❌ 登录表单未找到: ${String(e.message).slice(0, 100)}`);
    return false;
  }
  const ok = await isLoggedIn(page);
  log(ok ? '✅ 登录成功' : '❌ 登录后未检测到免费机卡片');
  return ok;
}

async function dumpState(context) {
  try {
    if (!fs.existsSync(CFG.shotDir)) fs.mkdirSync(CFG.shotDir, { recursive: true });
    const file = path.join(CFG.shotDir, 'storage-state.json');
    const st = await context.storageState({ path: file });
    const s = JSON.stringify(st);
    log(`💾 登录态已导出 ${file} (${s.length} bytes)`);
    return s;
  } catch (e) {
    log(`⚠️ 导出登录态失败: ${e.message}`);
    return null;
  }
}

async function updateGithubSecret(name, value) {
  if (!CFG.ghToken || !CFG.repo) { log('ℹ️ 未提供 GH_TOKEN/GITHUB_REPOSITORY，跳过回写 Secret'); return false; }
  const [owner, repo] = CFG.repo.split('/');
  try {
    const { execFile } = require('child_process');
    await new Promise((resolve, reject) => {
      execFile('gh', ['secret', 'set', name, '--body', value, '--repo', `${owner}/${repo}`],
        { env: { ...process.env, GH_TOKEN: CFG.ghToken }, timeout: 60000 },
        (err, so, se) => (err ? reject(new Error(se || err.message)) : resolve(so)));
    });
    log(`✅ 已更新 Secret: ${name}`);
    return true;
  } catch (e) {
    log(`⚠️ gh CLI 写入失败: ${String(e.message).slice(0, 200)}`);
    return false;
  }
}

/* ============================== 汇报 ============================== */

/** TG 报告（佬王 HidenCloud 风格）：标题 + 状态 + 账号 + 前后剩余时间 */
async function reportResults(result) {
  const STATUS = {
    SUCCESS: '✅ 续期成功', PENDING: '⏳ 未到续期时间/演练',
    NO_BUTTON: '❌ 未找到按钮', FAIL: '❌ 续期失败',
  };
  const lines = ['🎰 Kerit 续期报告', ''];
  lines.push(STATUS[result.status] || result.status);
  lines.push(`📧 账号: ${maskEmail()}`);
  if (result.before) lines.push(`⏱ 续期前剩余时间:${result.before}`);
  if (result.after) lines.push(`⏱ 续期后剩余时间:${result.after}`);
  if (result.note) lines.push(`📝 ${result.note}`);
  lines.push('');
  lines.push(`⏱ 时间: ${nowStr()}`);
  await sendTelegram(lines.join('\n'));
  const ICON = { SUCCESS: '🟢', PENDING: '⚪', NO_BUTTON: '🟡', FAIL: '🔴' };
  console.log('\n================ 汇总 ================');
  console.log(`${ICON[result.status]} ${result.before}${result.after ? ' ➔ ' + result.after : ''} ${result.note}`);
  if (result.status === 'FAIL' || result.status === 'NO_BUTTON') process.exitCode = 1;
}

/* ============================== 自检（无网络可跑） ============================== */

function runSelftest() {
  const cases = [
    [{}, 'FALLBACK'],
    [{ has_server: false }, 'SKIP'],
    [{ has_server: true, server: { abuse: true } }, 'FAIL'],
    [{ has_server: true, renews_per_week: 7, max_days: 7, server: { renews_this_week: 7, seconds_left: 3600 } }, 'SKIP'],
    [{ has_server: true, renews_per_week: 7, max_days: 7, server: { renews_this_week: 2, seconds_left: 7 * 86400 } }, 'SKIP'],
    [{ has_server: true, renews_per_week: 7, max_days: 7, server: { renews_this_week: 2, seconds_left: 3600 } }, 'GO'],
    [{ has_server: true, server: { suspended: true, seconds_left: 0 } }, 'GO'],
  ];
  let pass = 0;
  cases.forEach(([input, want], i) => {
    const got = decideGate(input).decision;
    const ok = got === want;
    if (ok) pass++;
    console.log(`${ok ? '✅' : '❌'} case${i + 1}: want=${want} got=${got}`);
  });
  console.log(`\nselftest: ${pass}/${cases.length} passed`);
  process.exit(pass === cases.length ? 0 : 1);
}

/* ============================== 主流程 ============================== */

if (process.argv.includes('--selftest')) runSelftest();

(async () => {
  const state = loadAuthState();
  if (!state && (!CFG.email || !CFG.password)) {
    console.error('❌ 需至少提供 AUTH_STATE，或 KERIT_EMAIL + KERIT_PASSWORD');
    process.exit(1);
  }

  log('#'.repeat(64));
  log('   Kerit Cloud (billing.kerit.cloud) 每日 heartbeat  v0.1');
  log(`   门控: capReached/atCeiling/abuse | DRY_RUN: ${CFG.dryRun}`);
  log(`   代理: ${CFG.proxyUrl || '直连'} | headless: ${CFG.headless} | 登录: ${state ? '登录态注入(可降级账密)' : '账密'}`);
  log('#'.repeat(64));

  if (!fs.existsSync(CFG.shotDir)) fs.mkdirSync(CFG.shotDir, { recursive: true });

  const launchOpts = {
    headless: CFG.headless,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage', '--window-size=1920,1080', '--lang=en-US', '--no-first-run',
    ],
  };
  if (CFG.proxyUrl) {
    const hp = parseProxyHostPort(CFG.proxyUrl);
    const alive = hp ? await tcpProbe(hp.host, hp.port, 5000) : false;
    if (alive) {
      try { launchOpts.proxy = { server: CFG.proxyUrl }; log(`🔗 代理存活: ${CFG.proxyUrl}，走代理`); } catch (e) { log(`⚠️ 代理参数无效: ${e.message}`); }
    } else {
      log(`⚠️ 代理不可连(${CFG.proxyUrl})，本次直连`);
      CFG.proxyUrl = '';
    }
  } else { log('🍭 直连模式（未配置 NODE_LINK 则 workflow 不起 sing-box）'); }
  if (CFG.channel) launchOpts.channel = CFG.channel;

  // 1) API 预检优先：SKIP 直接汇报退出，不启动浏览器
  log('📡 API 预检中（capReached/atCeiling 门控，未到期免开浏览器）…');
  const pre = await apiFreeStatus(state);
  log(`📡 预检: ${pre.decision}(${pre.note})`);
  if (pre.decision === 'SKIP') {
    log('✅ 未到续期窗口，本次免开浏览器');
    await reportResults({ status: 'PENDING', before: pre.left != null ? `${Math.round(pre.left / 3600 * 10) / 10}h` : null, after: null, note: pre.note });
    return;
  }
  if (pre.decision === 'FAIL') {
    log('⛔ TOS 违规，永久不可续，直接汇报');
    await reportResults({ status: 'FAIL', before: null, after: null, note: pre.note });
    return;
  }

  // 2) GO / FALLBACK 才启动浏览器
  const { chromium } = require('playwright');
  const browser = await chromium.launch(launchOpts);
  const ctxOpts = { viewport: { width: 1920, height: 1080 }, userAgent: CFG.ua, locale: CFG.locale, timezoneId: CFG.timezone };
  if (state) ctxOpts.storageState = state;
  const context = await browser.newContext(ctxOpts);

  let authOk = false;
  let dumped = null;
  const first = await context.newPage();
  try {
    if (state) {
      log('🍪 使用注入登录态访问 dashboard');
      await gotoRetry(first, CFG.dashboardUrl, { waitUntil: 'domcontentloaded', timeout: CFG.navTimeout });
      await sleep(3000);
      if (await isLoggedIn(first)) authOk = true;
      else log('⚠️ 登录态已失效，降级为账密登录');
    }
    if (!authOk && CFG.email && CFG.password) authOk = await doLogin(first);
    if (!authOk) {
      await safeShot(first, 'login-failed.png');
      await dumpState(context);
      throw new Error('登录失败（账密或登录态均不可用）');
    }
    dumped = await dumpState(context);
    if (dumped && CFG.autoUpdateState && CFG.ghToken) await updateGithubSecret('AUTH_STATE', dumped);
  } finally { await first.close().catch(() => {}); }

  const result = await renewHeartbeat(context);
  await context.storageState({ path: path.join(CFG.shotDir, 'storage-state-final.json') }).catch(() => {});
  await browser.close();
  log('🏁 浏览器已关闭');

  await reportResults(result);
})().catch(async (e) => {
  console.error('❌ 全局致命错误:', e.message);
  await sendTelegram(`🚨 Kerit 运行异常\n${String(e.message).slice(0, 200)}\n⏱ ${nowStr()}`);
  process.exit(1);
});
