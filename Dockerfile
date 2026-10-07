# For later hosting (e.g. Azure Container Apps). Not needed for local use.
FROM node:22-alpine
WORKDIR /app
COPY dist/server.mjs ./server.mjs
ENV MCP_TRANSPORT=http PORT=8080 NODE_ENV=production
EXPOSE 8080
USER node
CMD ["node", "server.mjs"]
