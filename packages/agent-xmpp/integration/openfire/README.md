# Openfire E2E image

The official Openfire **5.1.0** release tarball, run on `eclipse-temurin:25-jre` (the official image ships Java 17). Plugins are pre-installed at first boot:

| Plugin | Version | JAR |
|--------|---------|-----|
| Monitoring (MAM) | 2.7.0 | `monitoring.jar` |
| HTTP File Upload (XEP-0363) | 1.5.0 | `httpfileupload.jar` |
| REST API | 1.12.0 | `restAPI.jar` |

## Build

```bash
./build.sh
# or from integration/: docker compose build openfire
```

## Run (demoboot)

```bash
docker compose -f ../docker-compose.yml up -d openfire
```

Default admin: `admin` / `admin`. E2E domain: `example.org` (see `openfire-demoboot.xml`).

Image env defaults (for host-side scripts): `OPENFIRE_E2E_REST_SECRET=e2e-rest-secret`.

## REST API plugin

After first boot, bootstrap sets `adminConsole.access.allow-wildcards-in-excludes=true` and configures the REST API shared secret (required on Openfire 4.7+).

Host-side E2E uses `OPENFIRE_REST_SECRET` (default `e2e-rest-secret`) or falls back to admin Basic auth.

## Provisioning E2E

```bash
# from repo root — builds orchestrator, starts Openfire from this Dockerfile, runs phase 1 test
pnpm --filter orchestrator build
pnpm --filter @agent-xmpp/integration e2e:provision

# phase 2 runtime descriptor (Openfire + gateway)
pnpm --filter @agent-xmpp/gateway build
pnpm --filter @agent-xmpp/integration e2e:descriptor
```

## HTTP File Upload

Enable **HTTP Binding** in Server → Server Settings → HTTP Binding for `upload_file` E2E tests (bootstrap enables this automatically).
