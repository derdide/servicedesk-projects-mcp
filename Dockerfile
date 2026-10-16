# Multi-user HTTP mode image (Azure Container Apps or any container host).
# Built from source: the committed dist/ is not trusted for the image.
FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run typecheck && npm run build

FROM node:22-alpine
WORKDIR /app
COPY --from=build /src/dist/server.mjs ./server.mjs
ENV MCP_TRANSPORT=http PORT=8080 NODE_ENV=production
EXPOSE 8080
USER node
CMD ["node", "server.mjs"]
