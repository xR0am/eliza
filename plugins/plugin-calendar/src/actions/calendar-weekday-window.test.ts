import { AgentRuntime, type Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { createCalendarActionRunner } from "./calendar-handler.ts";
import { CalendarService } from "../service/CalendarService.ts";

describe("Calendar explicit date grounding through real handler", () => {
  it.each([
    {date:"2026-10-26",endDate:"2026-11-01",start:"2026-10-26T07:00:00.000Z",end:"2026-11-02T08:00:00.000Z",label:"from Monday, October 26, 2026 through Sunday, November 1, 2026, inclusive (America/Los_Angeles)"},
    {date:"2026-11-01",endDate:"2026-11-01",start:"2026-11-01T07:00:00.000Z",end:"2026-11-02T08:00:00.000Z",label:"on Sunday, November 1, 2026 (America/Los_Angeles)"},
  ])("keeps civil weekdays and end-exclusive bounds for $date..$endDate", async ({date,endDate,start,end,label}) => {
    const runtime=new AgentRuntime({character:{name:"Calendar date grounding",bio:[]}});
    const service=new CalendarService(runtime);runtime.services.set(CalendarService.serviceType,[service]);
    const feed={calendarId:"primary",events:[],source:"synced" as const,state:"complete" as const,sources:[],timeMin:start,timeMax:end,syncedAt:"2026-10-26T19:00:00.000Z"};
    const original=structuredClone(feed);
    const read=vi.spyOn(service,"getCalendarFeed").mockResolvedValue(feed);
    const unexpectedModel=vi.fn(async()=>{throw Error("Typed date read must not call a model");});
    const action=createCalendarActionRunner({runTextModel:unexpectedModel,runJsonModel:unexpectedModel,recentConversationTexts:async()=>[]});
    const message={id:"00000000-0000-0000-0000-000000000001",entityId:"00000000-0000-0000-0000-000000000002",roomId:"00000000-0000-0000-0000-000000000003",agentId:runtime.agentId,createdAt:new Date("2026-10-26T19:00:00Z").getTime(),content:{text:"Read the requested calendar range; do not change records."}} as Memory;
    const result=await action.handler(runtime,message,undefined,{parameters:{subaction:"feed",details:{date,endDate,timeZone:"America/Los_Angeles"}}});
    expect(result).toMatchObject({success:true,transcriptVisibility:"internal",modelReplyRequired:true,data:{replyContext:{scenario:"feed_results",facts:`No events ${label}.`,userFacingFacts:`No events ${label}.`,context:{label}}}});
    expect(read).toHaveBeenCalledOnce();
    expect(read.mock.calls[0]?.[1]).toMatchObject({timeMin:start,timeMax:end,timeZone:"America/Los_Angeles"});
    expect(result && typeof result === "object" && result.effectReceipts?.[0]).toMatchObject({operation:"calendar.feed.read",outcome:"noop"});
    expect(result).not.toHaveProperty("userFacingText");
    expect(unexpectedModel).not.toHaveBeenCalled();
    expect(feed).toEqual(original);
  });
});
