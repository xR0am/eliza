package ai.eliza.plugins.system;

/** One process-local, owner-bound assistant invocation. Never accepts caller Intent extras. */
public final class SenseInvocation {
    public static final long WINDOW_MS = 5000;
    private String session;
    private String origin;
    private String invocationSession;
    private long arrivedAt;
    private boolean locked;

    public synchronized void bind(String next) {
        if (next != null && !next.matches("[a-f0-9]{64}")) throw new IllegalArgumentException("Invalid invocation session");
        if (session == null ? next != null : !session.equals(next)) clear();
        session = next;
    }

    public synchronized void record(String hostPackage, String callerPackage, boolean sameSigner, long now, boolean lockedAtArrival) {
        origin = (hostPackage + ".sense").equals(callerPackage) && sameSigner ? "listener" : "assist";
        invocationSession = session;
        arrivedAt = now;
        locked = lockedAtArrival;
    }

    /** Returns null after consumption. Unknown or changed ownership never returns listener. */
    public synchronized String take(String expectedSession, long now, boolean lockedNow) {
        if (origin == null) return null;
        String result = "listener".equals(origin) && session != null && session.equals(expectedSession)
                && session.equals(invocationSession) && !locked && !lockedNow && now >= arrivedAt
                && now - arrivedAt <= WINDOW_MS ? "listener" : "assist";
        clear();
        return result;
    }

    private void clear() {
        origin = null;
        invocationSession = null;
        arrivedAt = 0;
        locked = true;
    }
}
