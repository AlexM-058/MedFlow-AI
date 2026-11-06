# Docker image of the MedFlow AI cloud service (cloud/server.ts), e.g. for Azure Container Apps.
# The Python extraction service (edge/extraction_service) is a separate service, not in this image.
#
# Build (from the MedFlow-AI folder):
#   docker build -t medflow-ai .
# Run locally (GEMINI_API_KEY comes from .env; the .env file is NOT copied into the image):
#   docker run --rm --env-file .env -e HOST=0.0.0.0 -p 8091:8091 medflow-ai
#
# On Azure this service must only be reachable from Backend (internal ingress), never public.

FROM node:22-slim
WORKDIR /app
# HOST=0.0.0.0: inside a container the server must listen on all interfaces,
# otherwise Backend (or `docker run -p`) cannot reach it.
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8091
COPY package.json package-lock.json ./
# Production dependencies only (tsx runs the .ts files; typescript and @types are not needed).
RUN npm ci --omit=dev
# cloud/ imports only core/; edge/ and scripts/ are not needed by this service.
COPY core ./core
COPY cloud ./cloud
# Run as the regular `node` user, not as root.
USER node
EXPOSE 8091
CMD ["node", "--import", "tsx", "cloud/server.ts"]
