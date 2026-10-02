# Folio — git-native collaborative wiki.
# Two-stage build: the `build` stage produces web/dist with the full
# dependency set; the runtime stage installs the server's production
# dependencies only (`npm ci --omit=dev`). Front-end packages (mermaid,
# excalidraw, react, codemirror…) live in devDependencies because vite has
# already bundled them into web/dist, which keeps the runtime image small.
# Building on Apple Silicon for an x86_64 host needs --platform linux/amd64.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.node.json ./
COPY shared ./shared
COPY web ./web
COPY server ./server
COPY db ./db
RUN npm run build

FROM node:22-alpine
# git — spaces are git clones; chromium + font-noto — PDF export (round 23):
# puppeteer-core needs a system browser (see server/export/pdf.ts), and
# without font-noto Cyrillic renders as boxes. tini — signals + git children.
# gcompat + libgcc — Folio AI: since 1.0.35 the @cursor/sdk platform package
# (@cursor/sdk-linux-x64 / -arm64, no musl variant exists) ships glibc-linked
# native addons (vendor/tree-sitter*/binding.node). Plain Alpine has no
# ld-linux-*.so.2, so the first assistant run fails with "Error loading shared
# library ld-linux-…" on either architecture. gcompat supplies the glibc loader
# names and libc.so.6/libm.so.6/libpthread.so.0, libgcc the libgcc_s.so.1 they
# need. musl programs (node, chromium) are not affected by it.
RUN apk add --no-cache git ca-certificates tini chromium font-noto gcompat libgcc
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY tsconfig.json tsconfig.node.json ./
COPY shared ./shared
COPY server ./server
# Guard: the SDK's native parts must load in THIS image. Without it an image
# that cannot start the assistant builds, boots and passes /api/health — the
# failure surfaces on a user's first Folio AI run. Keyless and offline (see the
# header of the script); fails the build with the library error, on any arch.
RUN node server/assistant/nativeCheck.mjs --sdk
COPY db ./db
COPY --from=build /app/web/dist ./web/dist

ENV NODE_ENV=production
ENV PORT=4870
# An explicit path instead of pdf.ts's fallback search: alpine's chromium
# package puts the binary exactly here; if it ever moves, export must fail
# with a clear "no chromium executable" rather than silently pick another.
ENV CHROMIUM_PATH=/usr/bin/chromium
VOLUME /app/data
EXPOSE 4870

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["npx", "tsx", "server/index.ts"]
