/** Read the gateway's sole active Cloudflare version for release receipts. */
import { pathToFileURL } from "node:url";

export async function activeGatewayDeployment(environment: string) {
  if (!["staging", "production"].includes(environment)) {
    throw new Error("Unsupported gateway environment");
  }
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (account !== "23cf6feaeaa541f6a0675053c33da768" || !token?.trim()) {
    throw new Error(
      "The gateway requires the protected Eliza Cloudflare account and credential",
    );
  }
  const service = `eliza-gateway-webhook-${environment}`;
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${service}/deployments`,
    {
      headers: { authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      `Cloudflare gateway deployment lookup failed (HTTP ${response.status})`,
    );
  }
  const body = await response.json();
  if (
    body?.success !== true ||
    !Array.isArray(body.result?.deployments) ||
    body.result.deployments.length === 0
  ) {
    throw new Error("Cloudflare did not return a gateway deployment");
  }
  const deployments = body.result.deployments;
  if (
    deployments.some((entry) => !Number.isFinite(Date.parse(entry.created_on)))
  ) {
    throw new Error("Invalid gateway deployment timestamps");
  }
  deployments.sort(
    (a, b) => Date.parse(b.created_on) - Date.parse(a.created_on),
  );
  const active = deployments[0];
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  if (
    !uuid.test(active.id) ||
    !Array.isArray(active.versions) ||
    active.versions.length !== 1 ||
    active.versions[0].percentage !== 100 ||
    !uuid.test(active.versions[0].version_id)
  ) {
    throw new Error("Gateway must have one fully deployed Cloudflare version");
  }
  const applicationsResponse = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/containers/applications`,
    {
      headers: { authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (!applicationsResponse.ok) {
    await applicationsResponse.body?.cancel();
    throw new Error(
      `Gateway image lookup failed (HTTP ${applicationsResponse.status})`,
    );
  }
  const applications = await applicationsResponse.json();
  if (applications?.success !== true || !Array.isArray(applications.result)) {
    throw new Error("Cloudflare did not return gateway applications");
  }
  const matching = applications.result.filter(
    (app) => app.name === `${service}-gatewaycontainer-webhook-${environment}`,
  );
  if (
    matching.length !== 1 ||
    typeof matching[0].configuration?.image !== "string"
  ) {
    throw new Error("The exact gateway container application was not found");
  }
  const image: string = matching[0].configuration.image;
  if (
    !image.startsWith(`registry.cloudflare.com/${account}/`) ||
    !/@sha256:[a-f0-9]{64}$/.test(image)
  ) {
    throw new Error(
      "Gateway application does not use an immutable Cloudflare image",
    );
  }
  return {
    service,
    image,
    deploymentId: active.id as string,
    versionId: active.versions[0].version_id as string,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const active = await activeGatewayDeployment(
      process.env.TARGET_ENVIRONMENT ?? "",
    );
    if (
      process.env.EXPECTED_GATEWAY_VERSION &&
      active.versionId !== process.env.EXPECTED_GATEWAY_VERSION
    ) {
      throw new Error("The expected gateway version is no longer active");
    }
    if (
      process.env.EXPECTED_GATEWAY_DEPLOYMENT &&
      active.deploymentId !== process.env.EXPECTED_GATEWAY_DEPLOYMENT
    ) {
      throw new Error("The expected gateway deployment is no longer active");
    }
    if (
      process.env.EXPECTED_GATEWAY_IMAGE &&
      active.image !== process.env.EXPECTED_GATEWAY_IMAGE
    ) {
      throw new Error("The expected gateway image is no longer configured");
    }
    console.log(JSON.stringify(active));
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : "Gateway deployment verification failed",
    );
    process.exitCode = 1;
  }
}
