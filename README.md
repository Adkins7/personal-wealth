# Personal Ledger · 个人资产管理仪表盘

清爽、可信、克制的私有个人财务与每日净资产仪表盘。基于 **Node.js 22 原生模块（`node:http`、`node:sqlite`、`node:crypto`）+ 现代 ES Modules** 构建，**零第三方依赖**，离线可用、秒级启动、单文件 SQLite 易于备份。

## 核心特性与口径
1. **登录与个人数据隔离**
   - 密码使用 `crypto.scrypt` 加随机盐哈希存储，会话令牌经 `HMAC-SHA256` 哈希后存入数据库，Cookie 启用 `HttpOnly` + `SameSite=Lax`。
   - 支持通过 `.env` 中的 `ALLOW_REGISTRATION=false` 在创建完自己的账号后关闭公开注册。
   - 支持一键隐藏全站金额（`¥ ••••••`）及导出全量 JSON / CSV 备份。
2. **信用付 / 负债**
   - 手动管理多家银行多张信用卡（银行、备注、授权额度、当前总欠款）及花呗、白条。
   - `负债总额 = 所有信用卡欠款 + 花呗欠款 + 白条欠款`；授权额度仅做展示，不计入负债或资产。
   - 安全红线：拦截完整银行卡号输入，不收集网银密码、短信验证码或 CVV。
3. **理财与资金账户**
   - 手动记录股票、支付宝基金（当前余额 + 当日盈亏）及储蓄卡、微信零钱等现金账户。
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

## 快速启动

```bash
# 1. 生成随机安全密钥写入 .env（首次运行）
node -e "const c=require('crypto'),fs=require('fs');if(!fs.existsSync('.env'))fs.writeFileSync('.env','SESSION_SECRET='+c.randomBytes(32).toString('hex')+'\nALLOW_REGISTRATION=true\nDATABASE_PATH=./data/wealth.db\nPORT=3080\n');"

# 2. 运行自动化验证测试
npm test

# 3. 启动服务（默认监听 http://127.0.0.1:3080）
npm start
```

## 技术栈与架构总结

本项目采用**零第三方依赖的轻量全栈架构**，离线可用、易于维护和备份：

### 1. 后端与运行时
- **Node.js 22（原生 ESM 模块）**：无需安装 `node_modules`，直接基于 Node 22 内置标准库运行：
  - `node:http` / `node:fs` / `node:path`：实现 REST API 路由、静态资源托管与防目录穿越校验（`server/index.mjs`、`server/routes.mjs`）。
  - **纯整数“分”金额引擎**：所有金额与汇总均以人民币“分”整数运算，避免浮点数精度误差（`server/money.mjs`、`server/summary.mjs`）。
  - 自定义 `.env` 环境变量加载器（`server/env.mjs`）。

### 2. 数据库与持久化
- **SQLite（Node 22 原生 `node:sqlite` / `DatabaseSync`）**：
  - 单文件本地存储（`data/wealth.db`），开启 **WAL 模式**、**外键级联删除（`PRAGMA foreign_keys = ON`）**、联合唯一索引及原子事务（`BEGIN / COMMIT / ROLLBACK`）（`server/db.mjs`）。
  - 支持 **JSON 全量备份** 与 **UTF-8 BOM CSV 导出**（兼容 Excel 中文不乱码）。

### 3. 前端与可视化
- **原生 HTML5 + 现代 CSS3（CSS Variables / Flexbox / Grid）**：手写设计系统，采用 `tabular-nums` 等宽财务数字排版、毛玻璃顶栏、柔和圆角卡片与克制的绿/红语义色（`public/index.html`、`public/styles.css`）。
- **原生 ES Modules（Vanilla JS）**：模块化拆分交互视图、表单弹窗、状态管理、API 请求封装及 HTML 转义防 XSS（`public/js/app.js`、`public/js/api.js`、`public/js/format.js`）。
- **自研交互式 SVG 图表 & 内联 SVG 图标**：不依赖外部图表库或 CDN，离线秒开，支持悬停查看每日净资产、差额与独立盈亏（`public/js/chart.js`、`public/js/icons.js`）。
- **浏览器 `localStorage`**：用于持久化“一键隐藏金额（防窥屏）”状态。

### 4. 安全与隐私技术（`node:crypto`）
- **密码存储**：`crypto.scryptSync` 加随机盐哈希 + `crypto.timingSafeEqual` 常量时间比对（`server/auth.mjs`）。
- **会话与防护**：随机 32 字节会话令牌经 `HMAC-SHA256` 哈希后入库；Cookie 启用 `HttpOnly` + `SameSite=Lax`；所有写接口校验自定义头 `X-Requested-With` 防 CSRF；内置登录失败频率限制与 `ALLOW_REGISTRATION` 注册开关。
- **数据隔离与脱敏**：全接口强制按 `user_id` 隔离，后端正则拦截 12–19 位完整银行卡号输入。

### 5. 测试、版本控制与部署
- **自动化测试**：Node 22 原生测试框架 `node:test` + `node:assert` + 内存 SQLite（`:memory:`），端到端验证公式、权限隔离、CSRF 和快照链（`tests/wealth.test.mjs`）。
- **容器化与托管**：提供基于 `node:22-alpine` 的 `Dockerfile` 及 Git / GitHub 版本管理。

