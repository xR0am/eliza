/** Shared ElizaClient augmentation; pure methods live in calendar-api. */
import {ElizaClient} from '@elizaos/ui';
import {installCalendarApi} from './calendar-api.js';
export {createCalendarApi,type CalendarApi,type CalendarApiHost,type CalendarClientMethods} from './calendar-api.js';
let installed=false;
export function installCalendarClient():void{if(installed)return;installCalendarApi(ElizaClient.prototype);installed=true;}
