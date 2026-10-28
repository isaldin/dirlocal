# Directus with dirlocal baked in. Since 12.1 extensions can't be npm-installed inside the container,
# so this is also the production install path. Build context: repository root.
FROM directus/directus:12.5.1

COPY --chown=node:node packages/directus-extension/package.json /directus/extensions/directus-extension-dirlocal/package.json
COPY --chown=node:node packages/directus-extension/dist /directus/extensions/directus-extension-dirlocal/dist
