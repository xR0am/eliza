/** Registers the Calendar-owned execution boundary without enabling LifeOps. */
import { type IAgentRuntime, Service } from "@elizaos/core";
import { CalendarService } from "../service/CalendarService.js";
import { createCalendarMutationPort } from "./port.js";
import { CALENDAR_MUTATION_PORT_SERVICE } from "./resolve.js";
import type { CalendarMutationPort } from "./types.js";
export class CalendarMutationPortService
  extends Service
  implements CalendarMutationPort
{
  static override serviceType = CALENDAR_MUTATION_PORT_SERVICE;
  override capabilityDescription =
    "Owner-approved Calendar mutations with durable provider receipts";
  private readonly port: CalendarMutationPort;
  constructor(runtime?: IAgentRuntime, calendar?: CalendarService) {
    super(runtime);
    if (!runtime)
      throw new Error("Calendar mutation service requires its runtime");
    this.port = createCalendarMutationPort(runtime, calendar);
  }
  static async start(runtime: IAgentRuntime) {
    const calendar =
      runtime.getService<CalendarService>(CalendarService.serviceType) ??
      ((await runtime.getServiceLoadPromise(
        CalendarService.serviceType,
      )) as CalendarService | null);
    if (!calendar)
      throw Error("Calendar service must start before its mutation port");
    return new CalendarMutationPortService(runtime, calendar);
  }
  preflight: CalendarMutationPort["preflight"] = (request) =>
    this.port.preflight(request);
  execute: CalendarMutationPort["execute"] = (request, preflight) =>
    this.port.execute(request, preflight);
  async stop() {}
}
