# Folio on DigitalOcean

## Not App Platform

DigitalOcean's App Platform has no persistent volumes: "App Platform does not
currently support volumes", and a service's local filesystem is wiped on every
deploy ([DigitalOcean docs](https://docs.digitalocean.com/products/app-platform/how-to/store-data/)).
Folio stores the Git repositories of your spaces on disk, so it cannot run
there, and a `.do/deploy.template.yaml` ("Deploy to DO" button) would give you
an instance that loses its pages at the next deploy. There is no such button
for that reason.

## Droplet with one script

A plain [Droplet](https://docs.digitalocean.com/products/droplets/) (a virtual
server) works well, and gets the same install as any VPS.

**Size:** the **Basic 2 GB / 1 vCPU** Droplet is the minimum; 4 GB is
comfortable for a team. The 25 GB disk is enough to start. Pick the Ubuntu 24.04 image.

### Create it with a cloud-init script

1. **Create** > **Droplets**. Choose a region, **Ubuntu 24.04**, the 2 GB size,
   and your SSH key.
2. Under **Advanced Options** > **Add Initialization scripts (free)**, paste
   [`cloud-init.yaml`](cloud-init.yaml). As written it runs on the Droplet's IP
   over plain http; for a real instance swap in the commented line with your
   domain.
3. Create the Droplet. Installing takes about five minutes. If you set a
   domain, create the DNS A record pointing at the Droplet's IP first or soon after
   (Caddy gets the certificate as soon as DNS answers).
4. Open `https://your.domain` (or `http://<droplet-ip>:4870`).

Without a domain the address is plain http: use it to try Folio, not to host a
team on the open internet.

### Or by hand

```bash
ssh root@<droplet-ip>
curl -fsSL https://get.docker.com | sh
FOLIO_DOMAIN=wiki.example.com bash -c "$(curl -fsSL https://raw.githubusercontent.com/evergreen-it-dev/folio/main/deploy/vps/install.sh)"
```

Everything else (settings, update, backup) is in [`../vps/`](../vps/README.md).
Turn on DigitalOcean **Backups** for the Droplet as a second layer, and add a
Cloud Firewall that allows only ports 22, 80 and 443.

## DigitalOcean Marketplace 1-Click

A listing in the [Marketplace](https://marketplace.digitalocean.com/) is a
separate process, not a file in this repository: you become a vendor, build a
Droplet snapshot with Packer using DigitalOcean's
[marketplace-partners](https://github.com/digitalocean/marketplace-partners)
scripts (which clean and security-check the image), and submit it for review in
the vendor portal. It is worth doing once Folio has users who ask for it. The
install script here is what the Packer provisioner would run.
