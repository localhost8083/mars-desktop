# Mars box: Ruby (Debian's Ruby + Bundler). FROM the base image.
ARG BASE=ghcr.io/omnirush-ai/box-base:2026.10.1
FROM ${BASE}
ENV GEM_HOME=/root/.gem BUNDLE_SILENCE_ROOT_WARNING=1 PATH=/root/.gem/bin:/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
RUN set -eux; apt-get update; apt-get install -y --no-install-recommends ruby-full; rm -rf /var/lib/apt/lists/*; gem install --no-document bundler; ruby -v; bundle -v
LABEL ai.mars.box.stack="ruby"
