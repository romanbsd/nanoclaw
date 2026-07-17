# syntax=docker/dockerfile:1
#
# Openfire 5.1 for XMPP E2E/integration tests, running on a Java 25 JRE.
# Plugins: monitoring (MAM), HTTP File Upload (XEP-0363), REST API, search 1.8.0.
#
# The official igniterealtime/openfire image ships Java 17 and is only tagged
# `latest` (no version pin). Openfire's compiled distribution is Java-agnostic,
# so we grab the version-pinned prebuilt release tarball and run it on
# eclipse-temurin:25-jre. No git clone, no Maven build.
#
# Build:
#   ./packages/agent-xmpp/integration/openfire/build.sh
#   docker compose -f packages/agent-xmpp/integration/docker-compose.yml build openfire

ARG OPENFIRE_VERSION=5.1.0
ARG MONITORING_PLUGIN_VERSION=2.8.0
ARG HTTPFILEUPLOAD_PLUGIN_VERSION=1.5.0
ARG RESTAPI_PLUGIN_VERSION=1.12.0
ARG SEARCH_PLUGIN_VERSION=1.8.0

# Official plugin JARs (ignite realtime plugin archive). The stock entrypoint
# copies /opt/plugins/*.jar into the data dir on first boot.
FROM alpine:3.21 AS plugins
ARG MONITORING_PLUGIN_VERSION
ARG HTTPFILEUPLOAD_PLUGIN_VERSION
ARG RESTAPI_PLUGIN_VERSION
ARG SEARCH_PLUGIN_VERSION
RUN apk add --no-cache curl && mkdir -p /opt/plugins \
 && curl -fsSL -o /opt/plugins/monitoring.jar     "https://www.igniterealtime.org/projects/openfire/plugins/${MONITORING_PLUGIN_VERSION}/monitoring.jar" \
 && curl -fsSL -o /opt/plugins/httpfileupload.jar "https://www.igniterealtime.org/projects/openfire/plugins/${HTTPFILEUPLOAD_PLUGIN_VERSION}/httpfileupload.jar" \
 && curl -fsSL -o /opt/plugins/restAPI.jar        "https://www.igniterealtime.org/projects/openfire/plugins/${RESTAPI_PLUGIN_VERSION}/restAPI.jar" \
 && curl -fsSL -o /opt/plugins/search.jar         "https://www.igniterealtime.org/projects/openfire/plugins/${SEARCH_PLUGIN_VERSION}/search.jar"

FROM eclipse-temurin:25-jre AS runtime
ARG OPENFIRE_VERSION
ARG MONITORING_PLUGIN_VERSION
ARG HTTPFILEUPLOAD_PLUGIN_VERSION
ARG RESTAPI_PLUGIN_VERSION
ARG SEARCH_PLUGIN_VERSION
ENV OPENFIRE_USER=openfire \
    OPENFIRE_DIR=/usr/local/openfire \
    OPENFIRE_DATA_DIR=/var/lib/openfire \
    OPENFIRE_LOG_DIR=/var/log/openfire \
    OPENFIRE_VERSION="${OPENFIRE_VERSION}" \
    OPENFIRE_E2E_REST_SECRET=e2e-rest-secret \
    OPENFIRE_E2E_ADMIN_USER=admin \
    OPENFIRE_E2E_ADMIN_PASS=admin

# start-stop-daemon (dpkg) + sudo drop privileges in the entrypoint; curl fetches
# the release + backs the compose healthcheck. Unpack the prebuilt distribution
# and stash conf/plugins/security as *_org — the entrypoint seeds the data volume
# from these on first boot.
RUN apt-get update \
 && apt-get install -y --no-install-recommends adduser dpkg curl sudo \
 && adduser --disabled-password --quiet --system \
      --home "${OPENFIRE_DATA_DIR}" --gecos "Openfire XMPP server" \
      --group "${OPENFIRE_USER}" \
 && curl -fsSL "https://download.igniterealtime.org/openfire/openfire_$(echo "${OPENFIRE_VERSION}" | tr . _).tar.gz" \
      | tar -xz -C /usr/local \
 && mv "${OPENFIRE_DIR}/conf" "${OPENFIRE_DIR}/conf_org" \
 && mv "${OPENFIRE_DIR}/plugins" "${OPENFIRE_DIR}/plugins_org" \
 && rm -f "${OPENFIRE_DIR}/plugins_org/search.jar" \
 && mv "${OPENFIRE_DIR}/resources/security" "${OPENFIRE_DIR}/resources/security_org" \
 && chmod +x "${OPENFIRE_DIR}/bin/openfire.sh" \
 && chown -R "${OPENFIRE_USER}:${OPENFIRE_USER}" "${OPENFIRE_DIR}" \
 && rm -rf /var/lib/apt/lists/*

COPY --chmod=0755 entrypoint.sh /sbin/entrypoint.sh
COPY --from=plugins /opt/plugins /opt/plugins

LABEL org.opencontainers.image.title="Openfire E2E (monitoring + httpfileupload + restAPI + search + provisioning)" \
      org.opencontainers.image.version="${OPENFIRE_VERSION}" \
      org.opencontainers.image.description="Openfire ${OPENFIRE_VERSION} on Java 25 with monitoring ${MONITORING_PLUGIN_VERSION}, httpfileupload ${HTTPFILEUPLOAD_PLUGIN_VERSION}, restAPI ${RESTAPI_PLUGIN_VERSION}, search ${SEARCH_PLUGIN_VERSION}. REST API provisioning E2E supported."

WORKDIR ${OPENFIRE_DIR}
HEALTHCHECK --interval=30s --timeout=10s --start-period=3m --retries=5 \
  CMD bash -c "(echo > /dev/tcp/127.0.0.1/5222) 2>/dev/null || exit 1"
EXPOSE 5222 5269 5275 7070 7443 9090 9091
VOLUME ["${OPENFIRE_DATA_DIR}", "${OPENFIRE_LOG_DIR}"]
ENTRYPOINT ["/sbin/entrypoint.sh"]
