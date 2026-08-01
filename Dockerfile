FROM node:24-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json ./
COPY patches ./patches

RUN npm ci

FROM node:24-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY tsconfig.json ./
COPY prisma ./prisma
COPY src ./src

RUN npx prisma generate
RUN npm run build
RUN npm prune --omit=dev && npm cache clean --force

FROM node:24-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

COPY --chown=node:node package.json ./
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/prisma ./prisma
COPY --from=builder --chown=node:node /app/node_modules ./node_modules

# Baileys auth + uploads need write access; /app itself is root-owned.
# Creating these as root before USER node also seeds ownership for named volumes.
RUN mkdir -p /app/.wa-sessions /app/uploads/template-media \
  && chown -R node:node /app/.wa-sessions /app/uploads

USER node

EXPOSE 5001
CMD ["node", "dist/index.js"]

