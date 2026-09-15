FROM node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3

LABEL org.opencontainers.image.source="https://github.com/instafy-dev/instafy"

# Explicitly refresh inherited PCRE2; this image has no other apt install step.
ARG PCRE2_MIN_VERSION=10.42-1+deb12u1
RUN apt-get update && apt-get install -y --no-install-recommends \
      libpcre2-8-0 \
    && test -n "${PCRE2_MIN_VERSION}" \
    && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' libpcre2-8-0)" ge "${PCRE2_MIN_VERSION}" \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY packages/provider-contract/package.json /app/node_modules/@instafy/provider-contract/package.json
COPY packages/provider-contract/index.js /app/node_modules/@instafy/provider-contract/index.js
COPY packages/provider-contract/index.d.ts /app/node_modules/@instafy/provider-contract/index.d.ts
COPY packages/frontend/scripts /app/packages/frontend/scripts

ENV INSTAFY_SPEECH_HOST_MODE=server
ENV LOCAL_SPEECH_HOST=0.0.0.0
ENV LOCAL_PROVIDER_HOST_HOST=0.0.0.0
ENV INSTAFY_SPEECH_BOOTSTRAP_ON_START=1

EXPOSE 8796 8797

CMD ["node", "/app/packages/frontend/scripts/server-speech-host.mjs"]
