# Deployment

This repository supports two practical modes:

1. local development
2. single-node production with Docker Compose

## 1. Local Development

```bash
cp .env.example .env
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env

docker compose up -d
npm --prefix backend install
npm --prefix backend run migrate
npm --prefix backend run dev
npm --prefix frontend install
npm --prefix frontend run dev
```

## 2. Single-Node Production

```bash
cp .env.example .env
cp frontend/.env.example frontend/.env
docker compose -f docker-compose.prod.yml up --build -d
```

## Environment Variable Groups

### Root `.env`

Used mainly by `docker-compose.prod.yml`.

- database and ports:
  - `DB_NAME`
  - `DB_USER`
  - `DB_PASSWORD`
  - `DB_PORT`
  - `API_PORT`
  - `FRONTEND_PORT`
- public origins:
  - `CORS_ORIGIN`
  - `PUBLIC_WEB_BASE_URL`
  - `PUBLIC_API_BASE_URL`
- secrets and tokens:
  - `OWNER_LINK_MASTER_KEY`
  - `CALLBACK_MASTER_KEY`
  - `SYSTEM_CRON_TOKEN`
- mail delivery:
  - `EMAIL_DELIVERY_MODE`
  - `EMAIL_FROM`
  - `SMTP_HOST`
  - `SMTP_PORT`
  - `SMTP_SECURE`
  - `SMTP_USER`
  - `SMTP_PASS`
  - `SMTP_FROM`
  - `SMTP_FROM_NAME`
- object storage and governed attachments:
  - `PLATFORM_MANAGED_DELIVERY_ENABLED`
  - `PLATFORM_MANAGED_*`
  - `OSS_*`
- runtime relay:
  - `RUNTIME_RELAY_*`

### Backend `backend/.env`

Used for non-container local development.

Most important values:

- `DATABASE_URL`
- `PUBLIC_WEB_BASE_URL`
- `PUBLIC_API_BASE_URL`
- `OWNER_LINK_MASTER_KEY`
- `CALLBACK_MASTER_KEY`
- `SYSTEM_CRON_TOKEN`
- `SMTP_*`
- `OSS_*`

### Frontend `frontend/.env`

Used by Vite during local dev and static builds.

- `VITE_API_BASE`
- `VITE_APP_BASE`
- `VITE_SITE_LOCALE`
- `VITE_LOCALE_SWITCH_EN_URL`
- `VITE_LOCALE_SWITCH_ZH_URL`

## Minimum Production Checklist

- set real `PUBLIC_WEB_BASE_URL`
- set correct `CORS_ORIGIN`
- replace every placeholder secret
- point SMTP to a real mail provider
- if using governed attachments, configure real `OSS_*`
- keep `.env` files out of Git
