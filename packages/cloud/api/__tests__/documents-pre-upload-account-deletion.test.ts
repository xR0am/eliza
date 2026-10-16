/**
 * A file sent to POST /api/v1/documents/pre-upload and never submitted stays
 * in the blob bucket. Account deletion removes an organization's objects by
 * their organization id, so a pending upload must carry it; otherwise the
 * file outlives the account. Real pre-upload route and real account-deletion
 * object-storage step; the bucket is in memory and the caller is mocked.
 */
import { expect, mock, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";
process.env.MOCK_REDIS = "1";

const ORG = "11111111-1111-4111-8111-1111111111a7";
const USER = "22222222-2222-4222-8222-2222222222a7";

const realAuth = { ...(await import("@elizaos/cloud-shared/auth")) };
mock.module("@elizaos/cloud-shared/auth", () => ({
  ...realAuth,
  requireUserOrApiKeyWithOrg: async () => ({
    id: USER,
    organization_id: ORG,
    organization: { id: ORG, name: "Org", is_active: true },
    is_active: true,
    role: "owner",
  }),
}));

const { Hono } = await import("hono");
const { default: preUploadRoute } = await import(
  "../v1/documents/pre-upload/route"
);
const { createAccountDeletionProviderAdapters } = await import(
  "../../shared/src/lib/services/account-deletion-provider-adapters"
);

type Stored = { customMetadata?: Record<string, string> };
function memoryBucket() {
  const objects = new Map<string, Stored>();
  return {
    objects,
    async put(key: string, _value: unknown, options: Stored = {}) {
      objects.set(key, { customMetadata: options.customMetadata });
    },
    async delete(key: string) {
      objects.delete(key);
    },
    async list() {
      return {
        objects: [...objects].map(([key, value]) => ({ key, ...value })),
        truncated: false,
      };
    },
  };
}

test("account deletion removes a pre-uploaded document that was never submitted", async () => {
  const bucket = memoryBucket();
  const app = new Hono().route("/api/v1/documents/pre-upload", preUploadRoute);
  const form = new FormData();
  form.append(
    "files",
    new File(["quarterly numbers"], "notes.txt", { type: "text/plain" }),
  );
  const response = await app.request(
    "/api/v1/documents/pre-upload",
    { method: "POST", body: form },
    { NODE_ENV: "test", RATE_LIMIT_DISABLED: "true", BLOB: bucket },
  );
  expect(response.status).toBe(200);
  expect(bucket.objects.size).toBe(1);

  const adapters = createAccountDeletionProviderAdapters({
    trajectoryStore: {
      reachable: async () => true,
      listOrganizationKeys: async () => [],
      deleteObject: async () => undefined,
    },
  });
  await adapters.primary_object_storage.execute({
    organizationId: ORG,
    userId: USER,
    blob: bucket,
  } as never);

  expect(bucket.objects.size).toBe(0);
});
