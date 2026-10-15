/** Legacy LifeOps composition over the Calendar-owned mutation port. */
import type { IAgentRuntime } from "@elizaos/core";
import {
  type CalendarMutationService,
  createCalendarMutationPort,
} from "@elizaos/plugin-calendar/mutations/port";
import { LifeOpsService } from "../service.js";

export type { CalendarMutationService };
export function createLifeOpsCalendarMutationPort(
  runtime: IAgentRuntime,
  service: CalendarMutationService = new LifeOpsService(runtime),
) {
  return createCalendarMutationPort(runtime, service);
}
