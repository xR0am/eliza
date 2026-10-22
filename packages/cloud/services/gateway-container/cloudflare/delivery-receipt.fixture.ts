import { handleDeliveryReceipts, receiptOwner } from "./delivery-receipt-state";

export { DeliveryReceiptState } from "./delivery-receipt-state";
export default {
  async fetch(
    request: Request,
    env: { DELIVERY_RECEIPT_STATE: DurableObjectNamespace },
  ) {
    const url = new URL(request.url);
    if (url.pathname === "/private") {
      const input = (await request.clone().json()) as { key: string };
      return env.DELIVERY_RECEIPT_STATE.getByName(
        receiptOwner(url.searchParams.get("owner") ?? input.key),
      ).fetch(request);
    }
    return handleDeliveryReceipts(request, {
      ...env,
      GATEWAY_KIND: "webhook",
      GATEWAY_RUNTIME_CONFIG: JSON.stringify({
        CLOUD_GATEWAY_RECEIPTS_BACKEND: "cloudflare",
        GATEWAY_RECEIPTS_TOKEN: "test-only",
      }),
    });
  },
};
