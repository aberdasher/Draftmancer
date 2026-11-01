# Hosted Draftmancer deployment

Runs this fork on myshelter behind its own tailscale node. Players reach it at
https://draft.draftbot.fyi through the droplet's nginx; DraftBot calls the control API
over the tailnet.

## Build (off-box)

The build needs about 3.6 GB of RAM, so build on a workstation, never on the droplet:

    docker build -t draftmancer-hosted:$(git rev-parse --short HEAD) .
    docker save draftmancer-hosted:<tag> | ssh myshelter docker load

## Run (myshelter)

Copy this folder to `~/draftmancer-hosted/`, create `hosted.env` there (chmod 600) with
`DRAFTBOT_API_TOKEN=<secret>`, then:

    DRAFTMANCER_TAG=<tag> docker compose up -d
    docker exec draftmancer-tailscale tailscale up --hostname=draftmancer   # first time only

DraftBot's `.env` needs the same secret as `DRAFTMANCER_API_TOKEN`, plus
`DRAFTMANCER_API_URL=http://draftmancer:8080` and
`DRAFTMANCER_BASE_URL=https://draft.draftbot.fyi`.

## Upgrade

Build and load the new tag, then `DRAFTMANCER_TAG=<tag> docker compose up -d`. Sessions
are dumped on SIGTERM and every 30 s, and restored on start.

## Upstream sync (at least weekly)

    git fetch upstream && git rebase upstream/master

Upstream ships frequent "Data update" commits with new card data; a stale fork shows
missing cards for new sets. Our changes are kept in `src/hosted/` with small hooks in
`src/server.ts`, `src/Session.ts`, `src/Persistence.ts`, `src/SocketType.ts` and
`client/src/App.ts`.

## Droplet nginx

The control API must never be reachable publicly. Express routing is case-insensitive,
so block it with a case-insensitive regex location:

    location ~* ^/api/hosted/ { return 404; }
