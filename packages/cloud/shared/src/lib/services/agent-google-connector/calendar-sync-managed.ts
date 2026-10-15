import {
  ManagedCalendarSyncProvider,
  CalendarSyncError,
  type CalendarSyncOwner,
} from "./calendar-sync-provider";
import { getGoogleAccessToken, getManagedGoogleConnectorStatus } from "./shared";
export const managedCalendarSyncProvider = new ManagedCalendarSyncProvider({
  async grant(owner: CalendarSyncOwner) {
    const scope = {
      organizationId: owner.organizationId,
      userId: owner.userId,
      grantId: owner.grantId,
      side: "owner" as const,
    };
    const status = await getManagedGoogleConnectorStatus(scope);
    const valid = (value: typeof status) => value.connected && value.connectionId === owner.grantId;
    if (!valid(status))
      throw new CalendarSyncError(
        403,
        "CALENDAR_SYNC_PERMISSION",
        "not_accepted",
        "The selected owner Calendar connection is unavailable.",
      );
    const token = await getGoogleAccessToken(scope),
      latest = await getManagedGoogleConnectorStatus(scope);
    if (
      token.connectionId !== owner.grantId ||
      !valid(latest) ||
      JSON.stringify([...status.grantedCapabilities].sort()) !==
        JSON.stringify([...latest.grantedCapabilities].sort())
    )
      throw new CalendarSyncError(
        403,
        "CALENDAR_SYNC_PERMISSION",
        "not_accepted",
        "The selected owner Calendar connection changed.",
      );
    return {
      connectionId: token.connectionId,
      token: token.accessToken,
      capabilities: latest.grantedCapabilities,
    };
  },
});
