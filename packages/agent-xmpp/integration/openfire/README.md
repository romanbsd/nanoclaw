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

## REST API plugin

After first boot, set `adminConsole.access.allow-wildcards-in-excludes=true` (required by the REST API plugin on Openfire 4.7+). E2E bootstrap can do this via the admin console or REST API.

## HTTP File Upload

Enable **HTTP Binding** in Server → Server Settings → HTTP Binding for `upload_file` E2E tests.
