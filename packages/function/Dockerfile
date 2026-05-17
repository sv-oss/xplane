FROM node:24-alpine

LABEL org.opencontainers.image.source="https://github.com/sv-oss/xplane"

WORKDIR /app

COPY . .

EXPOSE 9443
CMD ["node", "serve.mjs"]
