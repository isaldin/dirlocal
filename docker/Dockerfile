# Directus with the dirlocal extension preinstalled. Since Directus 12.1 extensions can't be npm-installed
# inside the container, so baking them into the image is the install path for non-sandboxed extensions.
#   docker build -f docker/Dockerfile -t directus-dirlocal .                     (from the repository root)
#   docker build -f docker/Dockerfile --build-arg DIRECTUS_VERSION=12.5.1 …    (pin the Directus version)
ARG DIRECTUS_VERSION=12.5.1

FROM node:22-alpine AS build
RUN npm install -g corepack@latest && corepack enable
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile --filter directus-extension-dirlocal && pnpm --filter directus-extension-dirlocal build

FROM directus/directus:${DIRECTUS_VERSION}
COPY --from=build --chown=node:node /src/packages/directus-extension/package.json /directus/extensions/directus-extension-dirlocal/package.json
COPY --from=build --chown=node:node /src/packages/directus-extension/dist /directus/extensions/directus-extension-dirlocal/dist
