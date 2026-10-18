# Mars box: Java (Debian's OpenJDK 17 + Maven; Gradle projects bring their wrapper). FROM the base image.
ARG BASE=ghcr.io/omnirush-ai/box-base:2026.10.1
FROM ${BASE}
ARG TARGETARCH
RUN set -eux; mkdir -p /usr/share/man/man1; apt-get update; apt-get install -y --no-install-recommends openjdk-17-jdk-headless maven; rm -rf /var/lib/apt/lists/*; java -version; mvn -v
ENV JAVA_HOME=/usr/lib/jvm/java-17-openjdk-${TARGETARCH:-amd64}
LABEL ai.mars.box.stack="java"
