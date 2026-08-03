<p align="center">
  <img src="assets/brand/bubblepilot-icon.png" width="128" alt="BubblePilot 圖示" />
</p>

<h1 align="center">BubblePilot</h1>

<p align="center">
  <a href="README.md">简体中文</a> ·
  <a href="README.en.md">English</a> ·
  <strong>繁體中文</strong>
</p>

<p align="center">
  <strong>讓 BlueBubbles 對話自動運轉。</strong>
</p>

<p align="center">
  面向 BlueBubbles 的自託管訊息監聽、內容歸檔、Bot 編排與 AI 互動平臺。
</p>

<p align="center">
  <a href="doc/目标需求.md">需求文件</a> ·
  <a href="doc/概要设计.md">架構設計</a> ·
  <a href="doc/部署与运维.md">部署與運維</a>
</p>

<p align="center">
  <a href="https://github.com/shigella520/BubblePilot/actions/workflows/ci.yml"><img src="https://github.com/shigella520/BubblePilot/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="MIT License" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-22-339933?logo=nodedotjs&logoColor=white" alt="Node.js 22" /></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white" alt="TypeScript 5" /></a>
  <a href="https://fastify.dev/"><img src="https://img.shields.io/badge/Fastify-5-000000?logo=fastify&logoColor=white" alt="Fastify 5" /></a>
  <a href="https://www.postgresql.org/"><img src="https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white" alt="PostgreSQL 16" /></a>
</p>

## 專案狀態

BubblePilot 已進入開發階段。可執行的 M1 訊息接入與歸檔閉環已支援 BlueBubbles `new-message` Webhook、監聽範圍過濾、PostgreSQL 冪等歸檔、健康檢查及 Token 保護的最小查詢 API。下一階段會實作事件匹配與基礎動作。

## 核心能力

- 監聽指定的一對一聊天與群組聊天。
- 按聊天範圍獨立保存並搜尋訊息內容。
- 使用關鍵詞、正規表示式、發送者與訊息類型匹配 Bot 事件。
- 透過可配置工作流編排條件、變數、AI 與回覆節點。
- 管理多個 OpenAI 相容 AI Provider，並按策略執行 Retry、Fallback 與自動降級。
- 透過 Web 登入和敏感操作二次驗證保護聊天資料。
- 使用 Docker Compose 自託管部署。

## 架構概覽

BubblePilot 將訊息接入、歸檔、事件匹配、工作流編排和外部服務適配拆分為清晰的模組。首期採用模組化單體和程序內佇列；節點、適配器與執行器均透過明確契約擴充，為未來獨立 Worker 或外部訊息佇列保留邊界。

![BubblePilot 總體架構](doc/architecture-overview.svg)

BlueBubbles 只負責訊息閘道，應用程式資料庫保存 BubblePilot 的工作流、執行記錄、歸檔中繼資料與稽核事實；節點透過註冊表擴充，編排器不綁定具體業務動作。

## 訊息與工作流流程

![BubblePilot 訊息到回覆流程](doc/message-workflow-flow.svg)

同一外部事件使用穩定的冪等鍵處理，訊息先標準化並按範圍歸檔，再匹配觸發器並鎖定工作流版本。AI、條件和回覆節點的執行狀態都可以追蹤、重試或進入人工處理。

## 快速開始

需要 Docker 與 Docker Compose。複製設定範本並替換所有 `CHANGE_ME`，尤其是資料庫密碼、API Token 與 Webhook Secret；再把需要歸檔的 BlueBubbles Chat GUID 寫入 `MONITORED_CHAT_IDS`：

```bash
cp .env.example .env
docker compose config
docker compose up -d --build
curl --fail http://127.0.0.1:8080/health/ready
```

在 BlueBubbles Server 訂閱 `New Messages`，Webhook URL 設定為：

```text
https://你的網域/api/v1/webhooks/bluebubbles?token=<BLUEBUBBLES_WEBHOOK_SECRET>
```

正式環境必須使用 HTTPS 或私有網路，並關閉反向代理對此路徑查詢字串的存取記錄。完整設定、驗證與查詢範例請見[部署與運維](doc/部署与运维.md)。設計入口：

1. [目標需求](doc/目标需求.md)
2. [概要設計](doc/概要设计.md)
3. [事件與工作流設計](doc/事件与工作流设计.md)
4. [BlueBubbles 整合說明](doc/BlueBubbles集成说明.md)

## 文件導航

| 想了解什麼 | 閱讀 |
| --- | --- |
| 產品目標、範圍與驗收標準 | [目標需求](doc/目标需求.md) |
| 典型使用者互動、異常路徑與驗收故事 | [典型使用者互動故事](doc/典型用户交互故事.md) |
| 階段目標與非目標 | [產品路線圖](doc/产品路线图.md) |
| 當前技術棧、選型理由與重評條件 | [技術選型](doc/技术选型.md) |
| 模組邊界與演進方式 | [概要設計](doc/概要设计.md) |
| 實體、狀態與幂等規則 | [資料模型與生命週期](doc/数据模型与生命周期.md) |
| 觸發器、節點與執行策略 | [事件與工作流設計](doc/事件与工作流设计.md) |
| 本地開發與測試 | [開發指南](doc/开发指南.md) |
| 分支、Commit 與 PR | [代碼管理規範](doc/代码管理规范.md) |
| 中文文件與翻譯規則 | [文件規範](doc/文档规范.md) |
| 安全、備份、升級與發布 | [安全與資料隱私](doc/安全与数据隐私.md) · [部署與運維](doc/部署与运维.md) · [版本與發布規範](doc/版本与发布规范.md) |

## 授權條款

BubblePilot 使用 [MIT License](LICENSE) 開源。

## 友情連結

<p align="center">
  <a href="https://linux.do" target="_blank">
    <img src="https://img.shields.io/badge/LINUX-DO-FFB003?style=for-the-badge&logo=linux&logoColor=white" alt="LINUX DO" />
  </a>
</p>
