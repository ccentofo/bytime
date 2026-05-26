# ByTime — DCAA-Compliant Timekeeping for Government Contractors

![Build Status](https://img.shields.io/badge/build-passing-brightgreen)
![Tests](https://img.shields.io/badge/tests-85%20passing-brightgreen)
![DCAA](https://img.shields.io/badge/DCAA-compliant-blue)

**ByTime** is a modern, fault-tolerant timekeeping and project management application designed specifically for Government Contractors (GovCon). It replaces legacy systems like Deltek, Unanet, and HourTimesheet with a vastly superior user experience while strictly adhering to DCAA compliance standards.

## 🎯 Demo

**Live Demo:** [https://bytime.vercel.app](https://bytime.vercel.app)

| Role | Email | Password |
|---|---|---|
| Admin | admin@bytime.dev | Password123! |
| Supervisor | sarah.wilson@bytime.dev | Password123! |
| Employee | jane.smith@bytime.dev | Password123! |

## ✨ Key Features

### DCAA Compliance (Built-In)
- ✅ **Append-Only Audit Trail** — Every change creates a new revision; nothing is ever deleted
- ✅ **Daily Time Entry** — Late entry detection with mandatory reason codes
- ✅ **Total Time Accounting** — FLSA exempt overtime tracking + indirect charge codes
- ✅ **Granular RBAC** — Employees can only charge to explicitly assigned CLINs
- ✅ **Digital Certification** — Employee submission + supervisor approval workflows
- ✅ **Audit Trail Viewer** — Full revision history with timeline visualization

### Modern UX
- 🌙 **Dark/Light Mode** — Seamless theme switching
- 📱 **Responsive Design** — Works on desktop, tablet, and mobile
- 🔌 **Offline Support** — Log time without internet; syncs automatically
- ⚡ **Fast** — Sub-second page loads with parallel data fetching
- 🔔 **Notifications** — Email alerts for submissions, approvals, rejections

### GovCon Data Model
- 📋 Contracts → CLINs → SLINs → Labor Categories → Employees
- 💰 Budget tracking with funded value, ceiling, and burn % visualization
- 📊 Cost reports (PDF, CSV, Excel) with effective-date rate accuracy
- 🏷️ Indirect charge codes (Overhead, G&A, IR&D, B&P, Leave)

### Administration
- 👥 User management with role-based access
- 🔐 Brute force protection + session invalidation
- 🔑 REST API with API key authentication
- 📧 Configurable email notifications
- 🗄️ Database migration system

## 🚀 Quick Start

### Prerequisites
- Node.js 21+
- PostgreSQL 16+ (or Docker)

### Setup

```bash
# Clone and install
git clone <repo-url>
cd bytime
npm install

# Start PostgreSQL
docker-compose up -d

# Push schema and seed data
npx drizzle-kit push
npm run db:seed:full

# Start dev server
npm run dev
```

Open http://localhost:3000 and login with any demo credentials above.

## 🧪 Testing

```bash
npm run test              # Unit tests (65 tests)
npm run test:integration  # Integration tests (20 tests, requires DB)
npm run test:all          # All tests
```

## 📦 Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16 (App Router, RSC, Server Actions) |
| UI | Mantine v9 + Mantine React Table v2 |
| Database | PostgreSQL 16 |
| ORM | Drizzle ORM |
| Auth | Auth.js v5 (JWT sessions) |
| Offline | Dexie.js (IndexedDB) |
| Testing | Vitest |
| Email | Resend + React Email |

## 📄 License

Proprietary — All rights reserved.
