FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY server ./server
COPY public ./public

RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3080
ENV DATABASE_PATH=/app/data/wealth.db

EXPOSE 3080

CMD ["node", "--no-warnings", "server/index.mjs"]
