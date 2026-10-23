package ai.eliza.plugins.browsersurface;

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
 * host. So a blocked host never receives the request at all. Thread safe; pure JVM.
 */
public final class BrowserMainFrameGate {
  private String committed;
  private final Set<String> approved = new HashSet<>();

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
    return origin.equals(committed) || approved.contains(origin);
  }
}
