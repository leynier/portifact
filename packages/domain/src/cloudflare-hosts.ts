// Cloudflare-owned domains a webhook may never point at (decision 0009, "Validating a URL"). A
// denylist, enumerated from Cloudflare's own documentation on 2026-11-10: it covers what those
// pages name, not every domain Cloudflare owns or will own. Each entry also refuses its
// subdomains. Keep it here, in one place, with the page each entry comes from.
export const CLOUDFLARE_HOSTS: readonly { domain: string; source: string }[] = [
  // Workers and Pages: every Worker's and project's default hostnames.
  {
    domain: "workers.dev",
    source: "developers.cloudflare.com/workers/configuration/routing/workers-dev/",
  },
  {
    domain: "pages.dev",
    source: "developers.cloudflare.com/pages/configuration/preview-deployments/",
  },
  // R2: public development URLs and the S3 API endpoints.
  { domain: "r2.dev", source: "developers.cloudflare.com/r2/buckets/public-buckets/" },
  { domain: "cloudflarestorage.com", source: "developers.cloudflare.com/r2/api/s3/api/" },
  // The API, the dashboard, time.cloudflare.com, a.nel.cloudflare.com and the rest of cloudflare.com.
  {
    domain: "cloudflare.com",
    source:
      "developers.cloudflare.com/cloudflare-one/connections/connect-devices/warp/deployment/firewall/",
  },
  // Partial (CNAME) setups point their hostnames at `<hostname>.cdn.cloudflare.net`.
  {
    domain: "cloudflare.net",
    source: "developers.cloudflare.com/dns/zone-setups/partial-setup/setup/",
  },
  // Tunnels: `<UUID>.cfargotunnel.com` (FedRAMP: `fed-cfargotunnel.com`) and Quick Tunnels.
  {
    domain: "cfargotunnel.com",
    source:
      "developers.cloudflare.com/cloudflare-one/connections/connect-networks/routing-to-tunnel/dns/",
  },
  {
    domain: "fed-cfargotunnel.com",
    source:
      "developers.cloudflare.com/cloudflare-one/connections/connect-networks/routing-to-tunnel/dns/",
  },
  {
    domain: "trycloudflare.com",
    source:
      "developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/",
  },
  // Zero Trust: DNS over HTTPS, Gateway, Access team domains and the WARP client's hosts.
  {
    domain: "cloudflare-dns.com",
    source:
      "developers.cloudflare.com/cloudflare-one/connections/connect-devices/warp/deployment/firewall/",
  },
  {
    domain: "cloudflare-gateway.com",
    source:
      "developers.cloudflare.com/cloudflare-one/connections/connect-devices/warp/deployment/firewall/",
  },
  {
    domain: "cloudflareaccess.com",
    source:
      "developers.cloudflare.com/cloudflare-one/connections/connect-devices/warp/deployment/firewall/",
  },
  {
    domain: "cloudflareclient.com",
    source:
      "developers.cloudflare.com/cloudflare-one/connections/connect-devices/warp/deployment/firewall/",
  },
  {
    domain: "cloudflareportal.com",
    source:
      "developers.cloudflare.com/cloudflare-one/connections/connect-devices/warp/deployment/firewall/",
  },
  {
    domain: "cloudflareok.com",
    source:
      "developers.cloudflare.com/cloudflare-one/connections/connect-devices/warp/deployment/firewall/",
  },
  {
    domain: "cloudflarecp.com",
    source:
      "developers.cloudflare.com/cloudflare-one/connections/connect-devices/warp/deployment/firewall/",
  },
  // 1.1.1.1's name, Web Analytics' beacon, Images and Stream delivery hosts.
  { domain: "one.one.one.one", source: "developers.cloudflare.com/1.1.1.1/setup/" },
  { domain: "cloudflareinsights.com", source: "developers.cloudflare.com/web-analytics/" },
  { domain: "imagedelivery.net", source: "developers.cloudflare.com/images/" },
  { domain: "videodelivery.net", source: "developers.cloudflare.com/stream/" },
  { domain: "cloudflarestream.com", source: "developers.cloudflare.com/stream/" },
  { domain: "cloudflare-ipfs.com", source: "developers.cloudflare.com/web3/" },
];

/** Whether `host` is one of `CLOUDFLARE_HOSTS` or a subdomain of one. */
export function isCloudflareHost(host: string): boolean {
  return CLOUDFLARE_HOSTS.some(({ domain }) => host === domain || host.endsWith(`.${domain}`));
}
