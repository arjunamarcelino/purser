# Static web image for one of Purser's two pages. Deploy it twice, once per WEB_TARGET.
# Every value below is public and frozen into the bundle at build time: never pass a key here.
FROM node:26.9.0-bookworm-slim AS build

ARG WEB_TARGET
ARG PURSER_CONTRACT_ID
ARG NEAR_NETWORK=testnet
ARG NEAR_RPC_URL=https://test.rpc.fastnear.com
ARG VITE_APP_URL

WORKDIR /repo
# Node 25+ no longer ships corepack; this is the version package.json pins.
RUN npm install --global pnpm@10.29.2
COPY . .

# Fail the build here rather than ship a board that throws on load.
RUN case "$WEB_TARGET" in \
      landing) ;; \
      app) [ -n "$PURSER_CONTRACT_ID" ] || { echo "PURSER_CONTRACT_ID is required for WEB_TARGET=app" >&2; exit 1; } ;; \
      *) echo "WEB_TARGET must be landing or app (got '$WEB_TARGET')" >&2; exit 1 ;; \
    esac \
    && pnpm install --frozen-lockfile --filter "@purser/$WEB_TARGET..." \
    && pnpm --filter "@purser/$WEB_TARGET" build \
    && mv "$WEB_TARGET/dist" /site

FROM nginx:1.29-alpine
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /site /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD wget -q -O /dev/null http://127.0.0.1/healthz || exit 1
