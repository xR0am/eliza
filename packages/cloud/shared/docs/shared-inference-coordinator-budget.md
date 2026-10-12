# Shared inference coordinator budget

The non-streaming coordinator waits for completed inference before returning headers. Applying a control-read deadline to this hop can cancel a healthy model call and manufacture a retry.

Current graph: message → prewarm → coordinator bridge (10-second headers limit) → hydration and inference → completed JSON response. A measured request took three Cloud attempts: 14,520 ms, 12,895 ms and 12,290 ms, totaling 39,705 ms before separate retry/delivery overhead. The final successful attempt included 6,867 ms of Shared work and 4,506 ms across four model calls. Failed-attempt billed-token counts are not established, and this measurement alone does not attribute every abort to the coordinator timer.

Intended budget: message → existing prewarm → one inference bridge bounded by the existing 75-second turn budget or earlier caller cancellation → completed response. Status, heartbeat, history/control reads and streaming response-header acquisition retain their ten-second deadline. Stream terminal generation retains its existing 75-second budget.

Cost: no new network calls, model calls, retries, polling or provider changes. A hung inference hop can remain live longer, but at most 75 seconds; caller cancellation still wins. This is a correctness fix for an inconsistent deadline, not a claim of faster model execution or a three-second response.

Focused tests cover late headers, unchanged control-read timeout, caller cancellation and a finite hung-turn deadline. Exact public integration and CI qualification remain required; production acceptance must re-measure attempts, latency and model calls after a separately approved release.
