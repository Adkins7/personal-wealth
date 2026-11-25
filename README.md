# Personal Ledger · 个人资产管理仪表盘

清爽、可信、克制的私有个人财务与每日净资产仪表盘。支持 **本地 SQLite 单机零配置运行** 与 **Vercel + Neon PostgreSQL / Turso 云端永久免费部署**。

## 核心特性与口径
1. **登录与个人数据隔离**
   - 密码使用 `crypto.scrypt` 加随机盐哈希存储，会话令牌经 `HMAC-SHA256` 哈希后存入数据库，Cookie 启用 `HttpOnly` + `SameSite=Lax`（HTTPS 下自动启用 `Secure`）。
   - 支持通过环境变量 `ALLOW_REGISTRATION=false` 在创建完自己的账号后关闭公开注册。
   - 支持一键隐藏全站金额（`¥ ••••••`）及导出全量 JSON / CSV 备份。
2. **信用付 / 负债**
   - **信用卡**：内置 30+ 家发卡银行下拉框（并支持自定义输入），只需填写**授权额度**与**剩余额度（云闪付可用额度）**，系统自动按 `当前欠款 = max(0, 授权额度 − 剩余额度)` 实时算出欠款并联动「每日快速盘点」。
   - **花呗 / 白条 / 其他信用付**：直接手动填写当前欠款。
   - `负债总额 = 所有信用卡自动算出的欠款 + 花呗欠款 + 白条欠款`；信用卡授权额度与剩余额度仅做展示，不计入负债或资产。
   - 安全红线：拦截完整银行卡号输入，不收集网银密码、短信验证码或 CVV。
3. **理财与资金账户**
   - 手动记录股票、支付宝基金（当前余额 + 当日盈亏）及储蓄卡（支持下拉选银行）、微信零钱等现金账户。
   - `资金总额 = 各资金账户当前余额合计`；`当日投资盈亏 = 股票当日盈亏 + 基金当日盈亏`。
4. **薅羊毛账本（独立统计，不计入净资产）**
   - 按日查看记录与当天结余；未兑现立减金/优惠券仅展示面值，不当现金。
   - 已售出/已兑现盈亏作为独立流量指标展示，避免与已入账的储蓄卡/微信余额重复累加。
5. **囤货估值**
   - 支持在「成本价」与「当前估值」两种统计口径间一键切换，并在总览、囤货页与历史快照中明确标注所用口径。
6. **每日资产快照**
   - `当日净资产 = 资金总额 − 负债总额 + 囤货估值（当前选定口径）`
   - `较前次变化 = 当日净资产 − 上一条历史快照净资产`
   - 独立展示「当日投资盈亏」与「当日羊毛结余」，避免与净资产变化混淆。

## 部署到 Vercel（免费在线方案）

1. 在 Vercel 控制台点击 **Add New... → Project**，导入 GitHub 仓库 `Adkins7/personal-wealth`。
2. 在导入页面的 **Environment Variables** 添加：
   - `SESSION_SECRET`：任意 32 位以上随机字符串
   - `ALLOW_REGISTRATION`：首次注册时填 `true`，注册好个人账号后可改为 `false`
3. 点击 **Deploy** 完成首次构建后，进入项目顶部的 **Storage** 选项卡 → 点击 **Create Database** → 选择 **Neon (Serverless Postgres)**（或 **Turso**）免费创建并点击 **Connect Project**（Vercel 会自动注入 `DATABASE_URL`）。
4. 回到 **Deployments** 点最新一条右侧菜单 **Redeploy**，即可上线使用。

## 本地快速启动

```bash
# 1. 生成随机安全密钥写入 .env（首次运行）
node -e "const c=require('crypto'),fs=require('fs');if(!fs.existsSync('.env'))fs.writeFileSync('.env','SESSION_SECRET='+c.randomBytes(32).toString('hex')+'\nALLOW_REGISTRATION=true\nDATABASE_PATH=./data/wealth.db\nPORT=3080\n');"

# 2. 运行自动化验证测试
npm test

# 3. 启动本地服务（默认监听 http://127.0.0.1:3080）
npm start
```

## 技术栈与架构总结

本项目采用轻量模块化全栈架构，兼顾本地离线单文件运行与 Serverless 云端部署：

### 1. 后端与运行时
- **Node.js 22（ESM 模块 + Vercel Serverless Functions）**：
  - 本地/容器通过 `node:http` 一体化运行（`server/index.mjs`），云端通过 `api/index.js` + `vercel.json` 无缝运行于 Vercel Serverless。
  - **纯整数“分”金额引擎**：所有金额与汇总均以人民币“分”整数运算，杜绝浮点数误差；日期统一锁定 `Asia/Shanghai` 时区（`server/money.mjs`、`server/summary.mjs`）。

### 2. 多引擎数据库适配层（`server/db.mjs`）
- **本地模式**：Node 22 原生 `node:sqlite`（`data/wealth.db`），零外部数据库依赖。
- **云端模式**：自动识别 `DATABASE_URL` / `POSTGRES_URL` 切换至 `@neondatabase/serverless`（Neon PostgreSQL），或识别 `TURSO_DATABASE_URL` 切换至 `@libsql/client`（Turso 云端 SQLite），首次请求自动建表与索引。
- 支持 **JSON 全量备份** 与 **UTF-8 BOM CSV 导出**（兼容 Excel 中文不乱码）。

### 3. 前端与可视化
- **原生 HTML5 + 现代 CSS3（CSS Variables / Flexbox / Grid）**：手写设计系统，采用 `tabular-nums` 等宽财务数字排版、毛玻璃顶栏、柔和圆角卡片与克制的绿/红语义色（`public/index.html`、`public/styles.css`）。
- **原生 ES Modules（Vanilla JS）**：模块化拆分交互视图、表单弹窗、状态管理、API 请求封装及 HTML 转义防 XSS（`public/js/app.js`、`public/js/api.js`、`public/js/format.js`）。
- **自研交互式 SVG 图表 & 内联 SVG 图标**：无外部 CDN 依赖，支持悬停查看每日净资产、差额与独立盈亏（`public/js/chart.js`、`public/js/icons.js`）。

### 4. 安全与隐私技术（`node:crypto`）
- **密码存储**：`crypto.scryptSync` 加随机盐哈希 + `crypto.timingSafeEqual` 常量时间比对（`server/auth.mjs`）。
- **会话与防护**：随机 32 字节会话令牌经 `HMAC-SHA256` 哈希后入库；Cookie 启用 `HttpOnly` + `SameSite=Lax` + 生产环境 `Secure`；所有写接口校验 `X-Requested-With` 防 CSRF；内置登录失败限流与注册开关。
- **数据隔离与脱敏**：全接口强制按 `user_id` 隔离，后端正则拦截 12–19 位完整银行卡号输入，前端支持 `localStorage` 金额防窥脱敏。

### 5. 测试与容器化
- **自动化测试**：Node 22 原生 `node:test` + `node:assert`，覆盖公式核算、权限隔离、CSRF 与 Vercel 路由模拟（`tests/wealth.test.mjs`）。
- **容器化**：提供基于 `node:22-alpine` 的 `Dockerfile`。
