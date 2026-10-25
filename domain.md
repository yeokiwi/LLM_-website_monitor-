# Using a Free afraid.org Subdomain

You can serve Website Monitor from a free subdomain from
[FreeDNS (afraid.org)](https://freedns.afraid.org), e.g. `mymonitor.mooo.com`.
It's an ordinary DNS record pointing at your droplet. Caddy (in
`docker-compose.yml`) gets the HTTPS certificate for it automatically.

This assumes the app is already deployed as described in
[docs/DEPLOY_DIGITALOCEAN.md](docs/DEPLOY_DIGITALOCEAN.md). The examples use
`mymonitor.mooo.com` as the name and `203.0.113.10` as the droplet IP.

---

## 1. Create the subdomain on afraid.org

1. Sign up at https://freedns.afraid.org and confirm your email.
2. Go to **Subdomains → Add** and fill in:
   - **Type:** `A`
   - **Subdomain:** a name you choose, e.g. `mymonitor`
   - **Domain:** pick one of the shared domains, e.g. `mooo.com`. The full list
     is under **Registry**. Older domains with many users tend to be more
     reliable.
   - **Destination:** your droplet's public IPv4 address, e.g. `203.0.113.10`
3. Solve the captcha and click **Save**.

You don't need FreeDNS's dynamic-DNS update scripts, because a droplet's IP
doesn't change. If you ever rebuild the droplet, update this record.
Alternatively, assign a DigitalOcean **Reserved IP** to the droplet and point the
record at that.

## 2. Check that it resolves to your droplet

On your computer or on the droplet:

```bash
dig +short mymonitor.mooo.com     # must print your droplet IP
```

A new record usually shows up within a few minutes. Don't continue until this
prints the right IP. Caddy can't get a certificate for a name that doesn't point
at the droplet.

## 3. Point the app at it

On the droplet, open the settings file:

```bash
cd /opt/website-monitor
nano .env
```

Set these two lines:

```dotenv
DOMAIN=mymonitor.mooo.com
APP_URL=https://mymonitor.mooo.com
```

Then apply the change and watch Caddy fetch the certificate:

```bash
docker compose up -d
docker compose logs -f caddy      # wait for "certificate obtained successfully"
```

Now open `https://mymonitor.mooo.com` and sign in. Ports 80 and 443 must be open
for this to work; `deploy/digitalocean/setup-droplet.sh` already allows them.

---

## Watch out: certificate limits on shared domains

Let's Encrypt allows only **50 certificates per week per registered domain**.
Everyone using subdomains of `mooo.com` shares that limit. On a popular domain the
limit may already be used up that week, and Caddy's log will say
`too many certificates already issued`. If that happens:

- **Wait and retry.** Caddy keeps retrying on its own, so it often succeeds within
  a few days.
- **Pick a less-crowded domain.** To see how busy a domain is, search it on
  https://crt.sh (e.g. `%.mooo.com`) and look at how many certificates were
  issued recently.
- **Add an email address to the Caddyfile.** Put a global options block at the
  top of `deploy/Caddyfile`:

  ```
  {
  	email you@example.com
  }
  ```

  You'll get certificate expiry notices, and Caddy can use the address to fall
  back to ZeroSSL, a second free certificate provider. Restart Caddy afterwards:

  ```bash
  docker compose restart caddy
  ```

## Keep in mind

The owner of a shared afraid.org domain can remove subdomains under it. For
long-term production use, a cheap domain of your own is safer. For a personal
monitor, a FreeDNS subdomain is fine.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `dig` prints nothing or a different IP | Check the record's **Destination** on afraid.org, wait a few minutes, and try again |
| Caddy log: `too many certificates already issued` | See [the section on certificate limits](#watch-out-certificate-limits-on-shared-domains) above |
| Caddy log: timeout or `connection refused` during validation | Ports 80/443 aren't reachable. Check `ufw status` and any DigitalOcean Cloud Firewall rules |
| Browser warns the certificate is invalid | Caddy hasn't got a certificate yet. Check `docker compose logs caddy` |
| Links in alert emails point to the wrong address | `APP_URL` in `.env` must be `https://<your subdomain>`. Run `docker compose up -d` after changing it |
