# Waleado API Backend

<div align="center">

![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue?style=for-the-badge&logo=typescript)
![Node.js](https://img.shields.io/badge/Node.js-20+-green?style=for-the-badge&logo=node.js)
![Express](https://img.shields.io/badge/Express-4.21-lightgrey?style=for-the-badge&logo=express)
![Prisma](https://img.shields.io/badge/Prisma-6.19-2D3748?style=for-the-badge&logo=prisma)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-15+-4169E1?style=for-the-badge&logo=postgresql)
![Baileys](https://img.shields.io/badge/WhatsApp-Baileys%207-25D366?style=for-the-badge&logo=whatsapp)

**Enterprise-grade WhatsApp marketing engine, multi-device socket bridge, visual chatbot runtime, automated call responder, and AI campaign orchestrator.**

</div>

---

## 📌 Overview

`waleado-api` is the backend service powering the **Waleado** multi-device WhatsApp automation ecosystem. Built with TypeScript, Express, Prisma ORM, and `@whiskeysockets/baileys`, it delivers high-throughput message scheduling, real-time bidirectional messaging, resilient connection handling, anti-ban protections, and AI-driven conversational automation.

---

## 🚀 Key Features

### 1. Multi-Device WhatsApp Engine
- **Direct Multi-Session Connection**: Leverages `@whiskeysockets/baileys` multi-device WebSockets with persistent credentials storage.
- **Dynamic QR Generation & Pair Code**: Instant QR code streaming and numeric phone pairing codes for seamless device linking.
- **Auto-Reconnect & State Recovery**: Automatic reconnection with exponential backoff and connection state synchronization.

### 2. High-Throughput Bulk Campaign Dispatcher
- **Multi-Device Routing Modes**:
  - `Single`: Send campaigns via a single dedicated device.
  - `Failover`: Automatically fallback to secondary devices when primary goes offline.
  - `Round-Robin`: Evenly distribute outbound messages across multiple connected WhatsApp numbers.
- **Anti-Block & Account Protection**:
  - **Dynamic Pacing**: Configurable randomized delays between messages (e.g. 15s–45s).
  - **Spintax Syntax Parser**: Dynamic text permutation syntax (e.g. `{Hello|Hi|Hey} {{name}}`).
  - **Batch Pausing**: Auto-pause for $N$ seconds after every $M$ sent messages.
  - **Fail Limits**: Auto-pause campaign if consecutive failures exceed threshold.
  - **Active/Inactive Sending Windows**: Timezone-aware quiet hours protection.
- **AI Text Variation Pool**: Generate dynamic message rewrites using configured AI credentials (OpenAI, Gemini, DeepSeek, Groq, Ollama, etc.) to ensure high message uniqueness.

### 3. Automated Call Responder
- **Lifecycle Call Event Detection**: Accurately detects `missed`, `rejected`, `timeout`, and `received` WhatsApp voice/video calls.
- **Instant & Scheduled Auto-Replies**: Sends pre-configured custom text messages or interactive templates when calls go unanswered.
- **Dynamic Variable Injection**: Automatically populates `{{phone}}`, `{{name}}` (synced with address book), `{{time}}`, and `{{date}}`.
- **Spam & Loop Prevention**: In-memory caller cooldown timers and deduplication protection.
- **Omnichannel Live Chat Synchronization**: Automatically syncs automated responses into `LiveChatThread` and `LiveChatMessage` history in real-time.

### 4. Interactive Chatbot Flow Builder
- **Visual Node Graph Execution**: Execution engine supporting Trigger, Message, Condition, Menu/List, Wait Delay, and AI Agent nodes.
- **Keyword & Intent Matching**: Exact, fuzzy, regex, and AI-driven intent routing.
- **Stateful Conversation Sessions**: Per-user conversation memory and context tracking.

### 5. Contact Management & WhatsApp Group Grabber
- **Group Participant Extractor**: Scrape all participant phone numbers and profile names directly from linked WhatsApp groups.
- **Bulk Import/Export**: Parse and validate phone numbers with E.164 standardization via `libphonenumber-js` with CSV/XLSX support.
- **Duplicate & Delivery Verification**: Track message delivery history, response rates, and activity status.

### 6. Billing & Subscription Management
- **SSLCommerz Payment Gateway**: Full sandbox and production support with automated currency conversion (USD to BDT), IPN verification, and webhook handling.
- **Stripe Subscriptions**: Seamless recurring billing with webhook event verification.
- **Role-Based Access Control**: Tiered quotas (Free, Pro, Business) for max devices, daily messages, and AI requests.

---

## 🛠 Tech Stack

- **Language**: TypeScript 5.7+
- **Runtime**: Node.js >= 20.9.0
- **Framework**: Express.js 4.21 with Helmet, HPP, CORS, Morgan, and Express-Rate-Limit
- **Database & ORM**: PostgreSQL with Prisma ORM 6.19
- **WhatsApp Bridge**: `@whiskeysockets/baileys` v7.0.0-rc.9
- **Authentication**: JWT (Access Token + Refresh Token in HTTP-only cookies) with bcryptjs password hashing
- **Phone Validation**: `libphonenumber-js`
- **Spreadsheets**: `xlsx` & `papaparse`
- **Payments**: `stripe` & `sslcommerz` integration

---

## 📁 Directory Structure

```
waleado-backend/
├── prisma/
│   ├── schema.prisma          # Complete PostgreSQL Prisma schema
│   ├── migrations/            # SQL migration history
│   └── seed.ts                # Database seeder (Admin, default plans)
├── scripts/
│   ├── free-port.cjs          # Port cleaner utility
│   └── run-prisma.cjs         # Environment-aware Prisma wrapper
├── src/
│   ├── index.ts               # Application entry point & server bootstrap
│   ├── env.ts                 # Zod-validated environment configuration
│   ├── lib/                   # Utilities, Prisma client, phone parser, rate limiter
│   ├── middleware/            # Auth, validation, error handling, rate limiting
│   ├── routes/                # Express API REST endpoints
│   │   ├── auth.routes.ts
│   │   ├── devices.routes.ts
│   │   ├── bulk-campaigns.routes.ts
│   │   ├── call-responder-rules.routes.ts
│   │   ├── chatbot.routes.ts
│   │   ├── contacts.routes.ts
│   │   ├── live-chat.routes.ts
│   │   ├── templates.routes.ts
│   │   ├── payments.routes.ts
│   │   └── admin.routes.ts
│   └── services/              # Core business logic & Baileys socket handlers
│       ├── baileys_manager.service.ts
│       ├── bulk_campaigns.service.ts
│       ├── call_responder_rules.service.ts
│       ├── chatbot_runtime.service.ts
│       ├── live_chat.service.ts
│       ├── payments_sslcommerz.service.ts
│       └── ai_engine.service.ts
├── package.json
└── tsconfig.json
```

---

## ⚙️ Environment Configuration

Create a `.env` file in the `waleado-backend` directory (or workspace root):

```env
# Server
NODE_ENV=development
PORT=4000
HTTP_JSON_BODY_LIMIT=10mb
CORS_ORIGIN=http://localhost:3000
APP_PUBLIC_URL=http://localhost:3000
API_PUBLIC_URL=http://localhost:4000

# Database (PostgreSQL)
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/waleado?schema=public"

# Security & JWT
JWT_ACCESS_SECRET=your_super_secret_jwt_access_key_min_32_characters_long
JWT_ACCESS_EXPIRES_IN=15m
REFRESH_TOKEN_DAYS=7
COOKIE_SECURE=false
COOKIE_SAME_SITE=lax

# WhatsApp Engine
WHATSAPP_BRIDGE_ENABLED=true
WA_SESSIONS_DIR=.wa-sessions

# Rate Limiting
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX=1000

# Payment Gateways (SSLCommerz)
SSLCOMMERZ_STORE_ID=your_store_id
SSLCOMMERZ_STORE_PASSWORD=your_store_password
SSLCOMMERZ_SANDBOX=true
SSLCOMMERZ_PRO_AMOUNT=29.00
SSLCOMMERZ_BUSINESS_AMOUNT=79.00
CONVERSION_RATE_USD_TO_BDT=120

# Payment Gateways (Stripe - Optional)
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
```

---

## 🚦 Getting Started

### 1. Install Dependencies
```bash
npm install
```

### 2. Database Migration & Prisma Client
```bash
# Generate Prisma Client
npm run db:generate

# Run migrations
npm run db:migrate

# (Optional) Seed initial admin and subscription plans
npm run db:seed
```

### 3. Run Development Server
```bash
npm run dev
```
The API server will start on `http://localhost:4000` with hot-reloading.

### 4. Build for Production
```bash
npm run build
npm run start
```

---

## 📡 Core API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/v1/auth/register` | Register new user & workspace |
| `POST` | `/v1/auth/login` | Authenticate user & issue tokens |
| `GET` | `/v1/devices` | List linked WhatsApp sessions |
| `POST` | `/v1/devices` | Initiate new device pairing / QR |
| `GET` | `/v1/bulk-campaigns` | List bulk message campaigns |
| `POST` | `/v1/bulk-campaigns` | Create and launch bulk campaign |
| `PATCH` | `/v1/bulk-campaigns/:id/:action` | Pause or resume campaign |
| `GET` | `/v1/call-responder-rules` | List missed/call auto-responder rules |
| `POST` | `/v1/call-responder-rules` | Create custom call response rule |
| `GET` | `/v1/live-chat/threads` | Fetch conversation threads |
| `POST` | `/v1/live-chat/messages` | Send real-time chat reply |
| `GET` | `/v1/chatbot/flows` | List automated visual chatbot flows |
| `POST` | `/v1/contacts/grab-groups` | Extract contacts from WhatsApp groups |
| `POST` | `/v1/payments/sslcommerz/initiate` | Initialize subscription checkout |

---

## 🔒 Security Best Practices

- **Zero Plaintext Secrets**: Passwords securely hashed with `bcryptjs` (salt rounds: 12).
- **Secure Cookie Handling**: HTTP-Only, SameSite cookies for refresh tokens.
- **SQL Injection Prevention**: Parameterized queries enforced across all database queries via Prisma ORM.
- **Rate Limiting & Anti-DDoS**: Configured via `express-rate-limit` and `helmet` security headers.

---

## 📄 License

Proprietary — Developed for Waleado platform.
