package ai.eliza.plugins.browsersurface;

import java.util.Collection;
import java.util.Collections;
import java.util.HashSet;
import java.util.Set;

/**
 * The last check before an intercepting surface sends a main-frame request.
 *
 * <p>{@code shouldOverrideUrlLoading} already holds cross-origin GET navigations, but WebView never
 * calls it for POST form submissions or history moves. {@code shouldInterceptRequest} sees those
 * requests on a network thread before anything is sent. A main-frame request may go out only to
 * the origin of the committed page or to an origin the host approved with {@code navigate()} (or
 * {@code createSurface}'s first address, or {@code goBack}'s entry). Anything else is answered
 * locally with an empty 204, which ends the navigation without a commit, and is reported to the
 * host. So a blocked host never receives the request at all. A running task the host extended to
 * more origins ({@code setTaskOrigins}) also admits a request from one of its origins to another.
 * Thread safe; pure JVM.
 */
public final class BrowserMainFrameGate {
  private String committed;
  private final Set<String> approved = new HashSet<>();
  private Set<String> taskOrigins = Collections.emptySet();

  /**
   * Replace the origins of the host's running task. Each entry must already be a canonical origin
   * ({@link BrowserWebOrigin#of}); an empty collection ends the extension. Returns false, changing
   * nothing, for any other entry.
   */
  public synchronized boolean setTaskOrigins(Collection<String> origins) {
    Set<String> next = new HashSet<>();
    for (String origin : origins) {
      if (origin == null || !origin.equals(BrowserWebOrigin.of(origin)) || !origin.startsWith("https://"))
        return false;
      next.add(origin);
    }
    taskOrigins = Collections.unmodifiableSet(next);
    return true;
  }

  /** The current task origins; a page may move between them by itself. */
  public synchronized Set<String> taskOrigins() {
    return taskOrigins;
  }

  /** The host loads this address itself; its origin may receive the main-frame request. */
  public synchronized void approve(String url) {
    String origin = BrowserWebOrigin.of(url);
    if (origin != null)
      approved.add(origin);
  }

  /** A main-frame document started for {@code url}; its origin becomes the page's own. */
  public synchronized void commit(String url) {
    committed = BrowserWebOrigin.of(url);
    if (committed != null)
      approved.remove(committed);
  }

  /** Whether a main-frame request for {@code url} may leave the device. */
  public synchronized boolean admit(String url) {
    String origin = BrowserWebOrigin.of(url);
    if (origin == null)
      return false;
    return origin.equals(committed) || approved.contains(origin)
        || (committed != null && taskOrigins.contains(committed) && taskOrigins.contains(origin));
  }
}
