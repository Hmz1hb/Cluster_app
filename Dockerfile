# syntax=docker/dockerfile:1

# NOTE: `npm ci` is intentionally avoided. @aws-amplify/backend-cli pulls
# platform-specific binaries (cdk-from-cfn) that npm cannot represent in a
# lock file `npm ci` will accept. Those are devDependencies the image never
# needs, so we install production deps only.
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

# public/ holds index.html, app.js, config.js, cognito-auth.js — the actual
# frontend. standalone does not copy it for you.
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000

CMD ["node", "server.js"]
