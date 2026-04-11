FROM node:20-alpine

WORKDIR /app

COPY backend/package*.json ./
RUN npm ci

COPY backend/tsconfig.json ./
COPY backend/src ./src
COPY backend/scripts ./scripts
COPY backend/sql ./sql
COPY skills ./skills
COPY docs ./docs

RUN npm run build

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=51011

EXPOSE 51011

CMD ["sh", "-c", "npm run migrate && node dist/src/server.js"]
