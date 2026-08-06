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
  面向 BlueBubbles 的自託管訊息監聽、內容歸檔、Bot 編排與 Agent 聯網搜尋平臺。
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
  <a href="https://vuejs.org/"><img src="https://img.shields.io/badge/Vue.js-3-42B883?logo=vuedotjs&logoColor=white" alt="Vue.js 3" /></a>
  <a href="https://vite.dev/"><img src="https://img.shields.io/badge/Vite-7-646CFF?logo=vite&logoColor=white" alt="Vite 7" /></a>
  <a href="https://www.postgresql.org/"><img src="https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white" alt="PostgreSQL 16" /></a>
</p>

## 專案狀態

BubblePilot 已完成 M0-M4：訊息歸檔、事件匹配、可編排工作流、多 AI Provider、Web 管理、搜尋、二次驗證與受控匯出均已形成閉環。AI 節點現已具備輕量 Agent 聯網搜尋能力，可按問題自動使用 Provider 託管搜尋或自託管 SearXNG。M5 的執行可靠性功能與運維工具已經實作，包括容量保護、失敗恢復、診斷與備份校驗；目前僅剩在目標環境完成 Compose 備份恢復及升級回滾演練。

## 核心能力

- 監聽指定的一對一聊天與群組聊天。
- 按聊天範圍獨立保存並搜尋訊息內容。
- 使用關鍵詞、正規表示式、發送者與訊息類型匹配 Bot 事件。
- 透過可配置工作流編排條件、變數、AI 與回覆節點。
- 管理多個 OpenAI 相容 AI Provider，並按策略執行 Retry、Fallback 與自動降級。
- 透過輕量 AgentRunner 自動判斷即時資訊需求，使用 Provider 託管搜尋或 SearXNG，並保留完整工具軌跡。
- 透過 Web 登入和敏感操作二次驗證保護聊天資料。
- 使用 Docker Compose 自託管部署。

## Agent 聯網搜尋

使用者只需提出「最近有什麼新進展？」這類自然問題，不必額外說「請聯網搜尋」。AI 節點可選擇三種策略：

- `auto`：向模型提供 `web_search` 工具，由模型判斷是否需要即時資訊。
- `required`：至少取得一條可用搜尋結果後才允許生成回答。
- `disabled`：完全關閉該節點的聯網能力。

BubblePilot 優先使用已通過能力探測的 Provider 託管搜尋；其他 OpenAI 相容 Provider 可透過 Function Calling 驅動程序內 AgentRunner，再由自託管 SearXNG 執行搜尋。搜尋結果一律視為不可信外部材料，不會作為系統指令執行；模型輪次、工具次數、逾時與結果長度均有硬性上限。

回覆中的來源可設定為完整、精簡或隱藏。無論是否向聊天參與者顯示連結，管理端的執行詳情都會保留 Provider Attempt、實際搜尋參數、正規化結果、引擎故障與工具狀態，方便解釋為何搜尋及返回了什麼。詳細語義請見[事件與工作流設計](doc/事件与工作流设计.md)。

## 架構概覽

BubblePilot 將訊息接入、歸檔、事件匹配、工作流編排和外部服務適配拆分為清晰的模組。首期採用模組化單體和程序內調度；節點、適配器與執行器均透過明確契約擴充，為未來獨立 Worker 或外部訊息佇列保留邊界。

![BubblePilot 總體架構](doc/architecture-overview.svg)

BlueBubbles 只負責訊息閘道，應用程式資料庫保存 BubblePilot 的工作流、執行記錄、歸檔中繼資料與稽核事實；節點透過註冊表擴充，編排器不綁定具體業務動作。

## 訊息與工作流流程

![BubblePilot 訊息到回覆流程](doc/message-workflow-flow.svg)

同一外部事件使用穩定的冪等鍵處理，訊息先標準化並按範圍歸檔，再匹配觸發器並鎖定工作流版本。AI、條件和回覆節點的執行狀態都可以追蹤、重試或進入人工處理。

## 快速開始

需要 Docker 與 Docker Compose。複製設定範本並替換所有 `CHANGE_ME`，尤其是資料庫密碼、API Token、Webhook Secret、BlueBubbles Server URL、存取令牌和 `SEARXNG_SECRET`；再把需要歸檔的 BlueBubbles Chat GUID 寫入 `MONITORED_CHAT_IDS`。AI 服務位址、模型與 Key 透過受保護的 Web 管理端設定：

```bash
cp .env.example .env
docker compose config
docker compose up -d --build
curl --fail http://127.0.0.1:8080/health/ready
```

Compose 已包含不向宿主機公開連接埠的 SearXNG。聯網搜尋預設關閉；需要使用時請在 `.env` 產生獨立隨機密鑰並啟用總開關：

```dotenv
ENABLE_WEB_SEARCH=true
SEARXNG_SECRET=CHANGE_ME_WITH_AT_LEAST_32_RANDOM_CHARACTERS
```

啟動後在「AI Provider」頁面分別探測基本連線、Function Calling 與 Provider 託管搜尋能力，再將 AI 節點策略設為 `auto` 或 `required`。

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

| 想了解什麼                         | 閱讀                                                                                                                |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 產品目標、範圍與驗收標準           | [目標需求](doc/目标需求.md)                                                                                         |
| 典型使用者互動、異常路徑與驗收故事 | [典型使用者互動故事](doc/典型用户交互故事.md)                                                                       |
| 階段目標與非目標                   | [產品路線圖](doc/产品路线图.md)                                                                                     |
| 當前開發狀態與短週期記錄           | [開發進度](doc/开发进度.md)                                                                                         |
| 當前技術棧、選型理由與重評條件     | [技術選型](doc/技术选型.md)                                                                                         |
| 模組邊界與演進方式                 | [概要設計](doc/概要设计.md)                                                                                         |
| 實體、狀態與幂等規則               | [資料模型與生命週期](doc/数据模型与生命周期.md)                                                                     |
| 觸發器、節點與執行策略             | [事件與工作流設計](doc/事件与工作流设计.md)                                                                         |
| 本地開發與測試                     | [開發指南](doc/开发指南.md)                                                                                         |
| 分支、Commit 與 PR                 | [代碼管理規範](doc/代码管理规范.md)                                                                                 |
| 中文文件與翻譯規則                 | [文件規範](doc/文档规范.md)                                                                                         |
| 安全、備份、升級與發布             | [安全與資料隱私](doc/安全与数据隐私.md) · [部署與運維](doc/部署与运维.md) · [版本與發布規範](doc/版本与发布规范.md) |

## 授權條款

BubblePilot 使用 [MIT License](LICENSE) 開源。

## 友情連結

<p align="center">
  <a href="https://linux.do" target="_blank">
    <img src="https://img.shields.io/badge/LINUX-DO-FFB003?style=for-the-badge&logo=linux&logoColor=white" alt="LINUX DO" />
  </a>
</p>
