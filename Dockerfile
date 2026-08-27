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

RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

# public/ holds index.html, app.js, config.js, cognito-auth.js — the actual
# frontend. standalone does not copy it for you.
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000

# ECS injects its own HOSTNAME env var into every container, which overrides
# any ENV set here. Next's standalone server binds to $HOSTNAME, so under ECS
# it would bind only to the task's ENI address: the ALB could reach it but
# 127.0.0.1 inside the container could not, failing the container health check.
# Setting it here, at exec time, is the one place ECS cannot override.
CMD ["sh", "-c", "exec env HOSTNAME=0.0.0.0 node server.js"]
